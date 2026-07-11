import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_PDF_SCOPE_TIMEOUT_MS,
  screenPdfTextScope,
  type PdfTextScopeScreening,
} from "./pdf-scope.ts";
import type { BookFormat } from "./types.ts";

const GUTENBERG_CATALOG_URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv";
const GUTENBERG_HARVEST_URL =
  "https://www.gutenberg.org/robot/harvest?filetypes[]=epub.images&langs[]=en";
const GUTENBERG_LICENSE_URL = "https://www.gutenberg.org/policy/license.html";
const DOAB_SEARCH_URL = "https://directory.doabooks.org/rest/search";
const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;
const DEFAULT_MIN_BOOK_BYTES = 1_024;
const USER_AGENT = "UniversalSpeedReader-BookParserLab/0.1 (standalone corpus research)";

// Kept stable so reruns have a recognizable classics core. Remaining EPUBs are
// deterministically sampled from the official illustrated-EPUB harvest.
export const CURATED_GUTENBERG_IDS = [
  1342, 84, 11, 1661, 98, 2701, 174, 345, 76, 43, 1232, 5200, 2591, 2600,
  28054, 1260, 768, 844, 1080, 2542, 3207, 1497, 1400, 158, 105, 161, 46,
  120, 55, 35, 36, 219, 2814, 730, 829, 996, 1952, 205, 1184, 1259, 244,
  2852, 6130, 1727, 1998, 4300, 4217, 514, 45, 2097, 1322, 100, 1513,
  1524, 1533, 1600, 19942, 3600, 2680, 4363, 1399, 2000, 132,
] as const;

export type CorpusItemStatus = "planned" | "downloaded" | "failed" | "excluded";
export type CorpusSelectionReason =
  | "golden-reference"
  | "curated-popular"
  | "harvest-variety"
  | "doab-open-access";

export interface CorpusManifestItem {
  id: string;
  remoteId: string;
  format: BookFormat;
  title: string;
  authors: string[];
  filename: string;
  relativePath: string;
  sourceName: string;
  sourceUrl: string;
  downloadUrl: string;
  discoveredDownloadUrl?: string;
  license: string;
  licenseUrl: string;
  selectionReason: CorpusSelectionReason;
  status: CorpusItemStatus;
  selected: boolean;
  attempts: number;
  byteLength?: number;
  sha256?: string;
  downloadedAt?: string;
  lastError?: string;
  pdfTextScope?: PdfTextScopeScreening;
}

export interface CorpusManifest {
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  target: { total: number; epub: number; pdf: number };
  sources: Array<{
    name: string;
    discoveryUrl: string;
    licensePolicyUrl: string;
  }>;
  items: CorpusManifestItem[];
}

export interface DownloadCorpusOptions {
  corpusDirectory: string;
  targetCount?: number;
  epubCount?: number;
  pdfCount?: number;
  concurrency?: number;
  retries?: number;
  requestTimeoutMs?: number;
  maxPdfBytes?: number;
  pdfScreenTimeoutMs?: number;
  refreshDiscovery?: boolean;
  strictTarget?: boolean;
}

export interface CorpusDownloadSummary {
  corpusDirectory: string;
  manifestPath: string;
  target: CorpusManifest["target"];
  downloaded: { total: number; epub: number; pdf: number };
  failedCandidates: number;
  complete: boolean;
}

interface DownloadContext {
  retries: number;
  requestTimeoutMs: number;
  maxPdfBytes: number;
  pdfScreenTimeoutMs: number;
  beforeGutenbergRequest: () => Promise<void>;
}

type PdfScopeScreener = (sourcePath: string, timeoutMs: number) => Promise<PdfTextScopeScreening>;

interface GutenbergCatalogRow {
  id: number;
  title: string;
  authors: string[];
}

interface DoabMetadataEntry {
  key?: unknown;
  value?: unknown;
}

interface DoabBitstream {
  uuid?: unknown;
  name?: unknown;
  bundleName?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  retrieveLink?: unknown;
  code?: unknown;
  metadata?: unknown;
}

interface DoabItem {
  uuid?: unknown;
  name?: unknown;
  handle?: unknown;
  metadata?: unknown;
  bitstreams?: unknown;
}

export function resolveCorpusTarget(options: DownloadCorpusOptions): CorpusManifest["target"] {
  const explicitTotal = options.targetCount;
  const proportionalEpub = explicitTotal === undefined ? 200 : Math.round(explicitTotal * 0.8);
  const proportionalPdf = explicitTotal === undefined ? 50 : explicitTotal - proportionalEpub;
  const epub = options.epubCount ??
    (explicitTotal !== undefined && options.pdfCount !== undefined ? explicitTotal - options.pdfCount : proportionalEpub);
  const pdf = options.pdfCount ??
    (explicitTotal !== undefined && options.epubCount !== undefined ? explicitTotal - options.epubCount : proportionalPdf);
  const total = epub + pdf;
  if (!Number.isInteger(epub) || !Number.isInteger(pdf) || epub < 0 || pdf < 0 || total < 1) {
    throw new Error("Corpus counts must be non-negative integers with at least one book");
  }
  if (explicitTotal !== undefined && total !== explicitTotal) {
    throw new Error(`epubCount + pdfCount (${total}) does not match targetCount (${explicitTotal})`);
  }
  if (total > 500) throw new Error("Phase 1 corpus is capped at 500 books");
  return { total, epub, pdf };
}

export async function loadCorpusManifest(manifestPath: string): Promise<CorpusManifest> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) {
    throw new Error(`Unsupported or malformed corpus manifest: ${manifestPath}`);
  }
  return parsed as unknown as CorpusManifest;
}

/**
 * Build or resume the legal-free local corpus. The production-sized default is
 * exactly 200 illustrated EPUBs plus 50 selectable-text candidate PDFs; passing
 * targetCount: 500 produces the supported 400/100 extension.
 */
export async function downloadCorpus(options: DownloadCorpusOptions): Promise<CorpusDownloadSummary> {
  const corpusDirectory = resolve(options.corpusDirectory);
  const manifestPath = join(corpusDirectory, "manifest.json");
  const target = resolveCorpusTarget(options);
  const concurrency = clampInteger(options.concurrency ?? 4, 1, 8);
  const context: DownloadContext = {
    retries: clampInteger(options.retries ?? 4, 1, 8),
    requestTimeoutMs: Math.max(5_000, options.requestTimeoutMs ?? 180_000),
    maxPdfBytes: options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES,
    pdfScreenTimeoutMs: Math.max(1, Math.min(30_000, options.pdfScreenTimeoutMs ?? DEFAULT_PDF_SCOPE_TIMEOUT_MS)),
    beforeGutenbergRequest: createRateLimiter(2_000),
  };

  await Promise.all([
    mkdir(join(corpusDirectory, "books", "epub"), { recursive: true }),
    mkdir(join(corpusDirectory, "books", "pdf"), { recursive: true }),
    mkdir(join(corpusDirectory, "source-cache"), { recursive: true }),
  ]);

  let manifest = await readManifestIfPresent(manifestPath, target);
  await refreshExistingDownloads(
    manifest,
    corpusDirectory,
    context.maxPdfBytes,
    context.pdfScreenTimeoutMs,
  );
  // Persist scope decisions before discovery. If a source API is temporarily
  // unavailable, an excluded scan must not be forgotten and downloaded again.
  manifest.target = target;
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(manifestPath, manifest);
  // A prior run may already have a large deterministic candidate reserve. Use
  // that reserve before making discovery APIs a prerequisite for a resumable
  // expansion; --refresh remains available when exhausted candidates need to
  // be replaced.
  const needsEpubDiscovery = options.refreshDiscovery === true || countAvailableFormat(manifest.items, "epub") < target.epub;
  const needsPdfDiscovery = options.refreshDiscovery === true || countAvailableFormat(manifest.items, "pdf") < target.pdf;
  const [epubCandidates, pdfCandidates] = await Promise.all([
    needsEpubDiscovery
      ? discoverGutenbergCandidates(corpusDirectory, Math.max(target.epub * 3, target.epub + 50), context)
      : Promise.resolve([]),
    needsPdfDiscovery
      ? discoverDoabCandidates(Math.max(target.pdf * 4, target.pdf + 50), context)
      : Promise.resolve([]),
  ]);

  manifest = mergeCandidates(manifest, [...epubCandidates, ...pdfCandidates], target);
  await writeManifest(manifestPath, manifest);

  await downloadFormatUntil(manifest, corpusDirectory, "epub", target.epub, concurrency, context, manifestPath);
  await downloadFormatUntil(manifest, corpusDirectory, "pdf", target.pdf, concurrency, context, manifestPath);

  selectDownloadedItems(manifest, "epub", target.epub);
  selectDownloadedItems(manifest, "pdf", target.pdf);
  manifest.updatedAt = new Date().toISOString();
  await writeManifest(manifestPath, manifest);

  const epub = manifest.items.filter((item) => item.selected && item.status === "downloaded" && item.format === "epub").length;
  const pdf = manifest.items.filter((item) => item.selected && item.status === "downloaded" && item.format === "pdf").length;
  const summary: CorpusDownloadSummary = {
    corpusDirectory,
    manifestPath,
    target,
    downloaded: { total: epub + pdf, epub, pdf },
    failedCandidates: manifest.items.filter((item) => item.status === "failed").length,
    complete: epub === target.epub && pdf === target.pdf,
  };
  if (!summary.complete && options.strictTarget !== false) {
    throw new Error(
      `Corpus incomplete after resumable download: ${epub}/${target.epub} EPUB and ${pdf}/${target.pdf} PDF. ` +
        `See ${manifestPath} for candidate errors, then rerun to resume.`,
    );
  }
  return summary;
}

async function discoverGutenbergCandidates(
  corpusDirectory: string,
  desired: number,
  context: DownloadContext,
): Promise<CorpusManifestItem[]> {
  const harvestUrls: string[] = [];
  let pageUrl: string | undefined = GUTENBERG_HARVEST_URL;
  while (pageUrl && harvestUrls.length < desired) {
    await context.beforeGutenbergRequest();
    const html = await fetchText(pageUrl, context);
    for (const match of html.matchAll(/https:\/\/aleph\.gutenberg\.org\/[^"<\s]+-images\.epub/gu)) {
      const url = match[0];
      if (!harvestUrls.includes(url)) harvestUrls.push(url);
    }
    const next = html.match(/href="(harvest\?offset=[^"#]+)"[^>]*>\s*(?:Next|&gt;)/iu);
    pageUrl = next ? new URL(next[1]!.replaceAll("&amp;", "&"), "https://www.gutenberg.org/robot/").href : undefined;
  }

  const curatedUrls = CURATED_GUTENBERG_IDS.map(
    (id) => `https://aleph.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`,
  );
  const variedUrls = harvestUrls
    .filter((url) => !CURATED_GUTENBERG_IDS.includes(gutenbergIdFromUrl(url) as never))
    .sort((left, right) => stableHash(left) - stableHash(right));
  const urls = [...curatedUrls, ...variedUrls].slice(0, desired);
  const wantedIds = new Set(urls.map(gutenbergIdFromUrl).filter((id): id is number => id !== undefined));
  const catalogPath = join(corpusDirectory, "source-cache", "pg_catalog.csv");
  if (!(await usableCacheExists(catalogPath))) {
    await context.beforeGutenbergRequest();
    const csv = await fetchText(GUTENBERG_CATALOG_URL, context, 80 * 1024 * 1024);
    await atomicWrite(catalogPath, csv);
  }
  const catalog = parseGutenbergCatalog(await readFile(catalogPath, "utf8"), wantedIds);

  return urls.flatMap((discoveredDownloadUrl): CorpusManifestItem[] => {
    const remoteId = gutenbergIdFromUrl(discoveredDownloadUrl);
    if (remoteId === undefined) return [];
    const row = catalog.get(remoteId);
    if (!row) return [];
    const reason: CorpusSelectionReason = remoteId === 1342
      ? "golden-reference"
      : CURATED_GUTENBERG_IDS.includes(remoteId as never)
        ? "curated-popular"
        : "harvest-variety";
    const filename = `${slug(row.title)}-pg${remoteId}.epub`;
    return [{
      id: `pg-${remoteId}`,
      remoteId: String(remoteId),
      format: "epub",
      title: row.title,
      authors: row.authors,
      filename,
      relativePath: join("books", "epub", filename),
      sourceName: "Project Gutenberg",
      sourceUrl: `https://www.gutenberg.org/ebooks/${remoteId}`,
      // The official harvest currently emits HTTPS URLs whose aleph certificate
      // has no matching SAN. Its same official mirror endpoint works over HTTP;
      // preserve both instead of weakening TLS verification process-wide.
      downloadUrl: discoveredDownloadUrl.replace(/^https:/u, "http:"),
      discoveredDownloadUrl,
      license: "Public domain in the United States; Project Gutenberg License",
      licenseUrl: GUTENBERG_LICENSE_URL,
      selectionReason: reason,
      status: "planned",
      selected: false,
      attempts: 0,
    }];
  });
}

async function discoverDoabCandidates(desired: number, context: DownloadContext): Promise<CorpusManifestItem[]> {
  const collected: CorpusManifestItem[] = [];
  // Stable 48-page illustrated PDF baseline used during parser/preview review.
  const baselineUrl = new URL(DOAB_SEARCH_URL);
  baselineUrl.searchParams.set("query", 'handle:"20.500.12854/35107"');
  baselineUrl.searchParams.set("expand", "metadata,bitstreams");
  baselineUrl.searchParams.set("limit", "1");
  try {
    const baselineValue = await fetchJson(baselineUrl.href, context);
    if (Array.isArray(baselineValue)) {
      const baseline = baselineValue.map(doabCandidate).find((item) => item !== undefined);
      if (baseline) collected.push(baseline);
    }
  } catch {
    // General discovery below can still build a valid corpus if the one-item
    // baseline lookup is temporarily unavailable.
  }
  // Expanded DOAB records include nested bitstream metadata; batches of 100
  // regularly close the response socket on this Mac before Bun can consume it.
  const pageSize = 20;
  for (let offset = 0; collected.length < desired && offset < 2_000; offset += pageSize) {
    const url = new URL(DOAB_SEARCH_URL);
    url.searchParams.set("query", "dc.language:English AND dc.type:book");
    url.searchParams.set("expand", "metadata,bitstreams");
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    const value = await fetchJson(url.href, context);
    if (!Array.isArray(value) || value.length === 0) break;
    for (const raw of value) {
      const candidate = doabCandidate(raw);
      if (candidate && !collected.some((item) => item.id === candidate.id)) collected.push(candidate);
    }
  }
  const baseline = collected.find((item) => item.remoteId === "20.500.12854/35107");
  const rest = collected
    .filter((item) => item !== baseline)
    .sort((left, right) => stableHash(left.id) - stableHash(right.id));
  return [...(baseline ? [baseline] : []), ...rest].slice(0, desired);
}

function doabCandidate(raw: unknown): CorpusManifestItem | undefined {
  if (!isRecord(raw)) return undefined;
  const item = raw as DoabItem;
  const metadata = metadataEntries(item.metadata);
  const bitstreams = Array.isArray(item.bitstreams) ? item.bitstreams.filter(isRecord) as DoabBitstream[] : [];
  const nestedMetadata = bitstreams.flatMap((entry) => metadataEntries(entry.metadata));
  const values = (key: string) => [...metadata, ...nestedMetadata]
    .filter((entry) => entry.key === key && typeof entry.value === "string")
    .map((entry) => entry.value as string);
  const title = firstString(values("dc.title")) ?? (typeof item.name === "string" ? item.name : undefined);
  const uuid = typeof item.uuid === "string" ? item.uuid : undefined;
  const handle = typeof item.handle === "string" ? item.handle : undefined;
  const downloadUrl = values("oapen.identifier.downloadUrl").find(isHttpsUrl);
  const licenseUrl = values("dc.rights.uri").find(isExplicitOpenLicense);
  const sourceUrl = values("dc.identifier.uri").find(isHttpsUrl) ??
    (handle ? `https://directory.doabooks.org/handle/${handle}` : undefined);
  if (!title || !uuid || !handle || !downloadUrl || !licenseUrl || !sourceUrl) return undefined;
  const filename = `${slug(title)}-doab-${slug(handle.split("/").at(-1) ?? uuid.slice(0, 8))}.pdf`;
  const authors = values("dc.contributor.author");
  const licenseCode = bitstreams.map((entry) => entry.code).find((value): value is string => typeof value === "string");
  return {
    id: `doab-${uuid}`,
    remoteId: handle,
    format: "pdf",
    title,
    authors,
    filename,
    relativePath: join("books", "pdf", filename),
    sourceName: "Directory of Open Access Books / OAPEN",
    sourceUrl,
    downloadUrl,
    discoveredDownloadUrl: downloadUrl,
    license: licenseCode ?? licenseUrl,
    licenseUrl,
    selectionReason: "doab-open-access",
    status: "planned",
    selected: false,
    attempts: 0,
  };
}

async function downloadFormatUntil(
  manifest: CorpusManifest,
  corpusDirectory: string,
  format: BookFormat,
  targetCount: number,
  concurrency: number,
  context: DownloadContext,
  manifestPath: string,
  downloadItem: typeof downloadCorpusItem = downloadCorpusItem,
): Promise<void> {
  const candidates = manifest.items.filter((item) => item.format === format);
  let downloaded = candidates.filter((item) => item.status === "downloaded").length;
  let cursor = 0;
  let active = 0;
  let saveChain = Promise.resolve();

  const persist = (): Promise<void> => {
    manifest.updatedAt = new Date().toISOString();
    saveChain = saveChain.then(() => writeManifest(manifestPath, manifest));
    return saveChain;
  };
  const claim = (): CorpusManifestItem | undefined => {
    if (downloaded + active >= targetCount) return undefined;
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!;
      if (candidate.status === "downloaded" || candidate.status === "excluded") continue;
      active += 1;
      return candidate;
    }
    return undefined;
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const item = claim();
      if (!item) return;
      await downloadItem(item, corpusDirectory, context);
      active -= 1;
      if (item.status === "downloaded") downloaded += 1;
      await persist();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  await saveChain;
}

async function downloadCorpusItem(
  item: CorpusManifestItem,
  corpusDirectory: string,
  context: DownloadContext,
): Promise<void> {
  item.attempts += 1;
  try {
    if (item.format === "pdf") await resolveOapenDownload(item, context);
    const absolutePath = safeCorpusPath(corpusDirectory, item.relativePath);
    const beforeRequest = item.sourceName === "Project Gutenberg" ? context.beforeGutenbergRequest : undefined;
    await downloadFile(item.downloadUrl, absolutePath, item.format, context, beforeRequest);
    const info = await stat(absolutePath);
    item.byteLength = info.size;
    item.sha256 = await sha256File(absolutePath);
    item.downloadedAt = new Date().toISOString();
    if (item.format === "pdf") {
      const screening = item.pdfTextScope ?? await screenPdfTextScope(absolutePath, context.pdfScreenTimeoutMs);
      applyPdfTextScopeScreening(item, screening);
      if (screening.status === "out-of-scope") await unlink(absolutePath).catch(() => undefined);
    } else {
      item.status = "downloaded";
    }
    delete item.lastError;
  } catch (error) {
    item.status = "failed";
    item.lastError = errorMessage(error);
  }
}

async function resolveOapenDownload(item: CorpusManifestItem, context: DownloadContext): Promise<void> {
  const current = new URL(item.downloadUrl);
  if (current.hostname !== "library.oapen.org" || current.pathname.startsWith("/rest/bitstreams/")) return;
  const match = current.pathname.match(/\/bitstream\/(20\.500\.12657\/[^/]+)/u);
  if (!match) throw new Error(`OAPEN download URL has no resolvable handle: ${item.downloadUrl}`);
  const apiUrl = `https://library.oapen.org/rest/handle/${match[1]}?expand=metadata,bitstreams`;
  const raw = await fetchJson(apiUrl, context);
  if (!isRecord(raw) || !Array.isArray(raw.bitstreams)) throw new Error("OAPEN handle response has no bitstreams");
  const originals = (raw.bitstreams as unknown[])
    .filter(isRecord)
    .filter((entry) => entry.bundleName === "ORIGINAL" && entry.mimeType === "application/pdf")
    .filter((entry) => typeof entry.sizeBytes === "number" && entry.sizeBytes <= context.maxPdfBytes)
    .sort((left, right) => Number(left.sizeBytes) - Number(right.sizeBytes));
  const chosen = originals[0];
  if (!chosen || typeof chosen.uuid !== "string") {
    throw new Error(`No ORIGINAL PDF at or below ${context.maxPdfBytes} bytes in OAPEN handle ${match[1]}`);
  }
  item.downloadUrl = `https://library.oapen.org/rest/bitstreams/${chosen.uuid}/retrieve`;
  if (typeof chosen.sizeBytes === "number") item.byteLength = chosen.sizeBytes;
  else delete item.byteLength;
}

async function downloadFile(
  url: string,
  destination: string,
  format: BookFormat,
  context: DownloadContext,
  beforeRequest?: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  if (await validBookFile(destination, format, context.maxPdfBytes)) return;
  const partial = `${destination}.part`;
  await withFetchRetry(url, context, async (response) => {
    let offset = await fileSize(partial);
    if (offset > 0 && response.status === 416 && await validBookFile(partial, format, context.maxPdfBytes)) {
      await rename(partial, destination);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const append = offset > 0 && response.status === 206;
    if (!append) offset = 0;
    const advertised = numberHeader(response.headers.get("content-length"));
    const limit = format === "pdf" ? context.maxPdfBytes : 250 * 1024 * 1024;
    if (advertised !== undefined && advertised + offset > limit) {
      throw new Error(`Remote file is ${advertised + offset} bytes, above ${limit}-byte limit`);
    }
    if (!response.body) throw new Error("Download response has no body");
    const handle = await open(partial, append ? "a" : "w");
    let received = offset;
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > limit) throw new Error(`Download exceeded ${limit}-byte limit`);
        await handle.write(chunk.value);
      }
    } finally {
      await handle.close();
    }
  }, beforeRequest, async () => {
    const offset = await fileSize(partial);
    return offset > 0 ? { Range: `bytes=${offset}-` } : {};
  });
  if (!(await validBookFile(partial, format, context.maxPdfBytes))) {
    throw new Error(`Downloaded file failed ${format.toUpperCase()} magic/size validation`);
  }
  await rename(partial, destination);
}

async function refreshExistingDownloads(
  manifest: CorpusManifest,
  corpusDirectory: string,
  maxPdfBytes: number,
  pdfScreenTimeoutMs: number,
  screenPdf: PdfScopeScreener = screenPdfTextScope,
): Promise<void> {
  for (const item of manifest.items) {
    if (item.status === "excluded") {
      item.selected = false;
      continue;
    }
    const path = safeCorpusPath(corpusDirectory, item.relativePath);
    if (await validBookFile(path, item.format, maxPdfBytes)) {
      const info = await stat(path);
      const sha256 = await sha256File(path);
      if (item.sha256 && item.sha256 !== sha256) {
        item.status = "planned";
        item.lastError = "Existing file SHA-256 does not match manifest";
        delete item.pdfTextScope;
      } else {
        item.status = "downloaded";
        item.byteLength = info.size;
        item.sha256 = sha256;
        delete item.lastError;
        if (item.format === "pdf") {
          const screening = item.pdfTextScope ?? await screenPdf(path, pdfScreenTimeoutMs);
          applyPdfTextScopeScreening(item, screening);
          if (screening.status === "out-of-scope") await unlink(path).catch(() => undefined);
        }
      }
    } else if (item.status === "downloaded") {
      item.status = "planned";
      item.lastError = "Downloaded file is missing or invalid; will resume/retry";
    }
  }
}

function applyPdfTextScopeScreening(item: CorpusManifestItem, screening: PdfTextScopeScreening): void {
  item.pdfTextScope = screening;
  item.selected = false;
  item.status = screening.status === "out-of-scope" ? "excluded" : "downloaded";
}

function mergeCandidates(
  manifest: CorpusManifest,
  discovered: CorpusManifestItem[],
  target: CorpusManifest["target"],
): CorpusManifest {
  const existing = new Map(manifest.items.map((item) => [item.id, item]));
  for (const candidate of discovered) {
    const previous = existing.get(candidate.id);
    if (!previous) {
      manifest.items.push(candidate);
      existing.set(candidate.id, candidate);
    } else if (previous.status !== "downloaded") {
      previous.title = candidate.title;
      previous.authors = candidate.authors;
      previous.sourceUrl = candidate.sourceUrl;
      previous.license = candidate.license;
      previous.licenseUrl = candidate.licenseUrl;
      previous.selectionReason = candidate.selectionReason;
      if (candidate.discoveredDownloadUrl) previous.discoveredDownloadUrl = candidate.discoveredDownloadUrl;
      else delete previous.discoveredDownloadUrl;
      if (!previous.downloadUrl.includes("/rest/bitstreams/")) previous.downloadUrl = candidate.downloadUrl;
    }
  }
  manifest.target = target;
  manifest.items.sort(compareCorpusItems);
  manifest.updatedAt = new Date().toISOString();
  return manifest;
}

function compareCorpusItems(left: CorpusManifestItem, right: CorpusManifestItem): number {
  if (left.format !== right.format) return left.format === "epub" ? -1 : 1;
  const pdfBaseline = "20.500.12854/35107";
  if (left.remoteId === pdfBaseline || right.remoteId === pdfBaseline) {
    return left.remoteId === pdfBaseline ? -1 : 1;
  }
  const rank = (reason: CorpusSelectionReason) => reason === "golden-reference" ? 0 : reason === "curated-popular" ? 1 : 2;
  return rank(left.selectionReason) - rank(right.selectionReason) || stableHash(left.id) - stableHash(right.id) || left.id.localeCompare(right.id);
}

function selectDownloadedItems(manifest: CorpusManifest, format: BookFormat, count: number): void {
  let remaining = count;
  for (const item of manifest.items.filter((candidate) => candidate.format === format)) {
    item.selected = item.status === "downloaded" && remaining-- > 0;
  }
}

function parseGutenbergCatalog(csv: string, wanted: Set<number>): Map<number, GutenbergCatalogRow> {
  const result = new Map<number, GutenbergCatalogRow>();
  let headers: string[] | undefined;
  for (const row of parseCsv(csv)) {
    if (!headers) {
      headers = row;
      continue;
    }
    const value = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""]));
    const id = Number(value["Text#"]);
    if (!wanted.has(id) || value.Type !== "Text" || !value.Language?.split(";").includes("en")) continue;
    const title = normalizeLabel(value.Title ?? "");
    if (!title) continue;
    result.set(id, {
      id,
      title,
      authors: (value.Authors ?? "").split(";").map(normalizeLabel).filter(Boolean),
    });
  }
  return result;
}

function* parseCsv(input: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/u, ""));
      yield row;
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) {
    row.push(field);
    yield row;
  }
}

async function readManifestIfPresent(path: string, target: CorpusManifest["target"]): Promise<CorpusManifest> {
  try {
    return await loadCorpusManifest(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      target,
      sources: [
        { name: "Project Gutenberg", discoveryUrl: GUTENBERG_HARVEST_URL, licensePolicyUrl: GUTENBERG_LICENSE_URL },
        { name: "DOAB / OAPEN", discoveryUrl: DOAB_SEARCH_URL, licensePolicyUrl: "https://www.doabooks.org/en/doab/policies" },
      ],
      items: [],
    };
  }
}

async function writeManifest(path: string, manifest: CorpusManifest): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

async function fetchText(url: string, context: DownloadContext, maxBytes = 10 * 1024 * 1024): Promise<string> {
  return withFetchRetry(url, context, async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const length = numberHeader(response.headers.get("content-length"));
    if (length !== undefined && length > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
    return text;
  });
}

async function fetchJson(url: string, context: DownloadContext): Promise<unknown> {
  const text = await fetchText(url, context, 30 * 1024 * 1024);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Expected JSON from ${url}`);
  }
}

async function withFetchRetry<T>(
  url: string,
  context: DownloadContext,
  consume: (response: Response) => Promise<T>,
  beforeRequest?: () => Promise<void>,
  headersForAttempt?: () => Promise<Record<string, string>>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= context.retries; attempt += 1) {
    await beforeRequest?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.requestTimeoutMs);
    try {
      const headers = {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        ...(await headersForAttempt?.()),
      };
      const response = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Retryable HTTP ${response.status} ${response.statusText}`);
      }
      return await consume(response);
    } catch (error) {
      lastError = error;
      if (attempt < context.retries) await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Request failed after ${context.retries} attempts: ${url}: ${errorMessage(lastError)}`);
}

async function validBookFile(path: string, format: BookFormat, maxPdfBytes: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < DEFAULT_MIN_BOOK_BYTES || (format === "pdf" && info.size > maxPdfBytes)) return false;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(1_024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead);
      return format === "epub"
        ? prefix[0] === 0x50 && prefix[1] === 0x4b && prefix[2] === 0x03 && prefix[3] === 0x04
        : prefix.includes(Buffer.from("%PDF-"));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeCorpusPath(corpusDirectory: string, relativePath: string): string {
  const path = resolve(corpusDirectory, relativePath);
  const relation = relative(resolve(corpusDirectory), path);
  if (relation.startsWith(`..${sep}`) || relation === ".." || resolve(relation) === relation) {
    throw new Error(`Manifest path escapes corpus directory: ${relativePath}`);
  }
  return path;
}

function createRateLimiter(intervalMs: number): () => Promise<void> {
  let queue = Promise.resolve();
  let nextAt = 0;
  return async () => {
    let release = () => {};
    const previous = queue;
    queue = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    const delay = Math.max(0, nextAt - Date.now());
    if (delay > 0) await sleep(delay);
    nextAt = Date.now() + intervalMs;
    release();
  };
}

function metadataEntries(value: unknown): DoabMetadataEntry[] {
  return Array.isArray(value) ? value.filter(isRecord) as DoabMetadataEntry[] : [];
}

function isExplicitOpenLicense(value: string): boolean {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  return url.hostname === "creativecommons.org" &&
    (url.pathname.startsWith("/licenses/") || url.pathname.startsWith("/publicdomain/"));
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function gutenbergIdFromUrl(url: string): number | undefined {
  const match = url.match(/\/epub\/(\d+)\/pg\1-images\.epub(?:$|\?)/u);
  return match ? Number(match[1]) : undefined;
}

function slug(value: string): string {
  const normalized = value.normalize("NFKD").replace(/\p{Mark}/gu, "").toLocaleLowerCase();
  const result = normalized.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 90);
  return result || "untitled";
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function countAvailableFormat(items: CorpusManifestItem[], format: BookFormat): number {
  return items.filter((item) => item.format === format && item.status !== "failed" && item.status !== "excluded").length;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function numberHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function usableCacheExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 1_024;
  } catch {
    return false;
  }
}

function firstString(values: string[]): string | undefined {
  return values.find((value) => normalizeLabel(value).length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Useful to CLIs without exposing path assumptions elsewhere.
export function corpusBookPath(corpusDirectory: string, item: CorpusManifestItem): string {
  return safeCorpusPath(resolve(corpusDirectory), item.relativePath);
}

export function recognizableCorpusFilename(item: Pick<CorpusManifestItem, "filename">): string {
  return basename(item.filename);
}

export const CORPUS_TESTABLES = {
  applyPdfTextScopeScreening,
  countAvailableFormat,
  downloadFormatUntil,
  refreshExistingDownloads,
};
