import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeMarkup, normalizeArchivePath, parseReference, SelectiveZipArchive } from "./epub-archive.ts";
import type { EvaluationRecord, ParsedBook, ParserDiagnostic } from "./types.ts";

const MAX_PREVIEW_PARAGRAPHS = 600;
const MAX_INLINE_IMAGE_LENGTH = 256 * 1024;

export interface FailurePreviewOptions {
  record: EvaluationRecord;
  book?: ParsedBook | null;
  parserStderr?: string;
  parserStdout?: string;
  imageUrlBySource?: Readonly<Record<string, string>>;
  previewKind?: "failure" | "spot-check";
}

export interface WriteFailurePreviewOptions extends FailurePreviewOptions {
  destinationPath: string;
}

export interface MaterializeEpubPreviewAssetsOptions {
  sourcePath: string;
  book: ParsedBook;
  assetDirectory: string;
  htmlDirectory: string;
  maxAssets?: number;
  maxTotalBytes?: number;
}

/** Render a self-contained, offline-safe diagnostic reader for a failed book. */
export function renderFailurePreview(options: FailurePreviewOptions): string {
  const { record, book } = options;
  const spotCheck = options.previewKind === "spot-check";
  const selected = book ? selectPreviewParagraphIds(book) : new Set<number>();
  const chaptersByParagraph = new Map<number, string[]>();
  const imagesByParagraph = new Map<number, ParsedBook["images"]>();
  if (book) {
    for (const chapter of book.chapters) {
      const values = chaptersByParagraph.get(chapter.startParagraphId) ?? [];
      values.push(chapter.title);
      chaptersByParagraph.set(chapter.startParagraphId, values);
    }
    for (const image of book.images) {
      const values = imagesByParagraph.get(image.afterParagraphId) ?? [];
      values.push(image);
      imagesByParagraph.set(image.afterParagraphId, values);
    }
  }
  const sourceLink = pathToFileURL(resolve(record.sourcePath)).href;

  const readingContent = book
    ? renderReadingContent(book, selected, chaptersByParagraph, imagesByParagraph, options.imageUrlBySource, sourceLink)
    : '<section class="empty"><h2>No parser output</h2><p>The process crashed, timed out, or returned unreadable JSON.</p></section>';
  const diagnostics = record.diagnostics.length > 0
    ? record.diagnostics.map(renderDiagnostic).join("\n")
    : spotCheck
      ? '<li class="diagnostic warning"><strong>Automatic checks passed; inspect the reading order below.</strong></li>'
      : '<li class="diagnostic warning"><strong>No structured diagnostic</strong></li>';
  const cover = book?.cover ? renderCover(book.cover.src, book.cover.mediaType, options.imageUrlBySource) : "";
  const chapterNavigation = book?.chapters.length
    ? `<nav class="chapters"><h2>Chapters (${book.chapters.length})</h2><ol>${book.chapters.map((chapter) =>
        `<li><a href="#p-${chapter.startParagraphId}">${escapeHtml(chapter.title)}</a><small>¶ ${chapter.startParagraphId}</small></li>`).join("")}</ol></nav>`
    : '<nav class="chapters"><h2>Chapters</h2><p>None extracted.</p></nav>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: file:">
  <title>${spotCheck ? "Spot-check" : "Failure"} preview — ${escapeHtml(record.title)}</title>
  <style>${PREVIEW_CSS}</style>
</head>
<body>
  <header class="masthead">
    <div><span class="eyebrow">Book Parser Lab · ${spotCheck ? "manual spot-check" : "failure preview"}</span><h1>${escapeHtml(record.title)}</h1>
      <p>${escapeHtml(record.format.toUpperCase())} · ${formatMilliseconds(record.elapsedMs)} · <a href="${escapeAttribute(sourceLink)}">open source file</a></p>
    </div>${cover}
  </header>
  <section class="diagnostics"><h2>${spotCheck ? "Automatic evidence" : "Why this book failed"}</h2><ul>${diagnostics}</ul></section>
  <div class="layout">
    ${chapterNavigation}
    <main>
      ${book ? `<section class="facts">${renderFacts(book, selected.size)}</section>` : ""}
      ${readingContent}
      ${renderProcessDetails(options)}
    </main>
  </div>
</body>
</html>`;
}

export async function writeFailurePreview(options: WriteFailurePreviewOptions): Promise<string> {
  const destinationPath = resolve(options.destinationPath);
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporary = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, renderFailurePreview(options), "utf8");
  await rename(temporary, destinationPath);
  return destinationPath;
}

/**
 * Preview-only bounded extraction. It leaves parser pointers untouched and
 * inflates only referenced EPUB assets (plus direct SVG image dependencies).
 */
export async function materializeEpubPreviewAssets(
  options: MaterializeEpubPreviewAssetsOptions,
): Promise<Record<string, string>> {
  const maxAssets = options.maxAssets ?? 80;
  const maxTotalBytes = options.maxTotalBytes ?? 24 * 1024 * 1024;
  const archive = new SelectiveZipArchive(new Uint8Array(await readFile(options.sourcePath)));
  const primarySources = [options.book.cover?.src, ...options.book.images.map((image) => image.src)]
    .filter((value): value is string => typeof value === "string" && !value.startsWith("data:"))
    .map((value) => normalizeArchivePath(value))
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .slice(0, maxAssets);
  const selected = selectAssetsWithinLimit(archive, primarySources, maxAssets, maxTotalBytes);
  archive.readMany(selected, maxTotalBytes);

  const dependencies: string[] = [];
  for (const source of selected.filter((value) => value.toLocaleLowerCase().endsWith(".svg"))) {
    const markup = decodeMarkup(archive.read(source, maxTotalBytes));
    for (const match of markup.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^)'"\s]+)["']?\s*\)/giu)) {
      const raw = match[1] ?? match[2];
      if (!raw) continue;
      const dependency = parseReference(source, raw).path;
      if (dependency && /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu.test(dependency)) dependencies.push(dependency);
    }
  }
  const allSelected = selectAssetsWithinLimit(
    archive,
    [...selected, ...dependencies.filter((value) => !selected.includes(value))],
    maxAssets,
    maxTotalBytes,
  );
  archive.readMany(allSelected, maxTotalBytes);

  const mapping: Record<string, string> = {};
  for (const archivePath of allSelected) {
    const resolvedPath = archive.resolve(archivePath);
    if (!resolvedPath) continue;
    const destination = safeAssetPath(options.assetDirectory, resolvedPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, archive.read(resolvedPath, maxTotalBytes));
    const relativeUrl = relative(resolve(options.htmlDirectory), destination).split(sep).map(encodeURIComponent).join("/");
    mapping[archivePath] = relativeUrl;
    mapping[resolvedPath] = relativeUrl;
  }
  return mapping;
}

function renderReadingContent(
  book: ParsedBook,
  selected: Set<number>,
  chaptersByParagraph: Map<number, string[]>,
  imagesByParagraph: Map<number, ParsedBook["images"]>,
  imageUrlBySource: Readonly<Record<string, string>> | undefined,
  sourceFileUrl: string,
): string {
  const blocks: string[] = [];
  for (const image of imagesByParagraph.get(0) ?? []) {
    blocks.push(renderImage(image.src, image.alt, image.mediaType, 0, imageUrlBySource, sourceFileUrl));
  }
  let previousId = 0;
  for (const paragraph of book.paragraphs) {
    if (!selected.has(paragraph.id)) continue;
    if (previousId > 0 && paragraph.id > previousId + 1) {
      blocks.push(`<div class="omission">${paragraph.id - previousId - 1} paragraphs omitted from this bounded preview</div>`);
    }
    for (const title of chaptersByParagraph.get(paragraph.id) ?? []) {
      blocks.push(`<h2 class="chapter-title">${escapeHtml(title)}</h2>`);
    }
    blocks.push(`<p class="paragraph" id="p-${paragraph.id}"><span class="paragraph-id">${paragraph.id}</span>${escapeHtml(paragraph.text)}</p>`);
    for (const image of imagesByParagraph.get(paragraph.id) ?? []) {
      blocks.push(renderImage(image.src, image.alt, image.mediaType, paragraph.id, imageUrlBySource, sourceFileUrl));
    }
    previousId = paragraph.id;
  }
  return `<article class="book-content">${blocks.join("\n")}</article>`;
}

function renderImage(
  src: string,
  alt: string,
  mediaType: string | undefined,
  anchor: number,
  imageUrlBySource: Readonly<Record<string, string>> | undefined,
  sourceFileUrl: string,
): string {
  const materializedUrl = imageUrlBySource?.[src] ?? imageUrlBySource?.[normalizeArchivePath(src)];
  const canDisplay = materializedUrl !== undefined || (src.startsWith("data:image/") && src.length <= MAX_INLINE_IMAGE_LENGTH);
  const image = canDisplay
    ? `<img src="${escapeAttribute(materializedUrl ?? src)}" alt="${escapeAttribute(alt)}">`
    : renderPointerPlaceholder(src, sourceFileUrl);
  return `<figure>${image}<figcaption><strong>Image after ¶ ${anchor}</strong>${alt ? ` — ${escapeHtml(alt)}` : ""}<code>${escapeHtml(src)}</code>${mediaType ? `<small>${escapeHtml(mediaType)}</small>` : ""}</figcaption></figure>`;
}

function renderPointerPlaceholder(src: string, sourceFileUrl: string): string {
  const page = src.match(/^pdf:\/\/page\/(\d+)/u)?.[1];
  if (page) {
    return `<div class="image-placeholder">PDF image pointer retained. <a href="${escapeAttribute(`${sourceFileUrl}#page=${page}`)}">Open source PDF at page ${page}</a>.</div>`;
  }
  return '<div class="image-placeholder">Pointer retained; the referenced asset could not be materialized in this bounded offline preview.</div>';
}

function renderCover(
  src: string,
  mediaType: string | undefined,
  imageUrlBySource: Readonly<Record<string, string>> | undefined,
): string {
  const materializedUrl = imageUrlBySource?.[src] ?? imageUrlBySource?.[normalizeArchivePath(src)];
  if (materializedUrl || (src.startsWith("data:image/") && src.length <= MAX_INLINE_IMAGE_LENGTH)) {
    return `<figure class="cover"><img src="${escapeAttribute(materializedUrl ?? src)}" alt="Extracted cover"><figcaption>${escapeHtml(mediaType ?? "cover")}</figcaption></figure>`;
  }
  return `<div class="cover pointer"><strong>Cover pointer</strong><code>${escapeHtml(src)}</code></div>`;
}

function renderDiagnostic(diagnostic: ParserDiagnostic): string {
  const details = diagnostic.details
    ? `<details><summary>Details</summary><pre>${escapeHtml(JSON.stringify(diagnostic.details, null, 2))}</pre></details>`
    : "";
  return `<li class="diagnostic ${diagnostic.severity}"><span>${escapeHtml(diagnostic.severity)}</span><strong>${escapeHtml(diagnostic.bucket)}</strong><p>${escapeHtml(diagnostic.message)}</p>${details}</li>`;
}

function renderFacts(book: ParsedBook, previewedParagraphs: number): string {
  const values = [
    ["Words", book.totals.words.toLocaleString("en-US")],
    ["Paragraphs", book.paragraphs.length.toLocaleString("en-US")],
    ["Chapters", book.chapters.length.toLocaleString("en-US")],
    ["Images", book.images.length.toLocaleString("en-US")],
    ["Previewed ¶", previewedParagraphs.toLocaleString("en-US")],
  ];
  return values.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
}

function renderProcessDetails(options: FailurePreviewOptions): string {
  const details: string[] = [];
  if (options.parserStderr) details.push(`<details><summary>Parser stderr</summary><pre>${escapeHtml(truncate(options.parserStderr, 100_000))}</pre></details>`);
  if (options.parserStdout) details.push(`<details><summary>Parser stdout</summary><pre>${escapeHtml(truncate(options.parserStdout, 100_000))}</pre></details>`);
  return details.length ? `<section class="process"><h2>Process evidence</h2>${details.join("")}</section>` : "";
}

function selectPreviewParagraphIds(book: ParsedBook): Set<number> {
  if (book.paragraphs.length <= MAX_PREVIEW_PARAGRAPHS) return new Set(book.paragraphs.map((paragraph) => paragraph.id));
  const ids = new Set<number>();
  const addWindow = (center: number, radius: number) => {
    for (let id = Math.max(1, center - radius); id <= Math.min(book.paragraphs.length, center + radius); id += 1) ids.add(id);
  };
  for (let id = 1; id <= Math.min(120, book.paragraphs.length); id += 1) ids.add(id);
  for (let id = Math.max(1, book.paragraphs.length - 39); id <= book.paragraphs.length; id += 1) ids.add(id);
  for (const chapter of book.chapters) addWindow(chapter.startParagraphId, 2);
  for (const image of book.images) addWindow(Math.max(1, image.afterParagraphId), 2);
  const stride = Math.max(1, Math.ceil(book.paragraphs.length / 160));
  for (let id = 1; id <= book.paragraphs.length; id += stride) ids.add(id);
  if (ids.size <= MAX_PREVIEW_PARAGRAPHS) return ids;
  // Insertion priority guarantees front matter, ending, chapters, then image
  // neighborhoods survive the cap; rendering still follows paragraph order.
  return new Set([...ids].slice(0, MAX_PREVIEW_PARAGRAPHS));
}

function selectAssetsWithinLimit(
  archive: SelectiveZipArchive,
  paths: string[],
  maxAssets: number,
  maxTotalBytes: number,
): string[] {
  const result: string[] = [];
  let total = 0;
  for (const path of paths) {
    const resolvedPath = archive.resolve(path);
    if (!resolvedPath || result.includes(resolvedPath)) continue;
    const size = archive.entries.get(resolvedPath)?.uncompressedSize ?? maxTotalBytes + 1;
    if (size < 0 || total + size > maxTotalBytes) continue;
    result.push(resolvedPath);
    total += size;
    if (result.length >= maxAssets) break;
  }
  return result;
}

function safeAssetPath(root: string, archivePath: string): string {
  const rootPath = resolve(root);
  const destination = resolve(rootPath, normalizeArchivePath(archivePath));
  const relation = relative(rootPath, destination);
  if (relation === ".." || relation.startsWith(`..${sep}`)) throw new Error(`EPUB asset escapes preview directory: ${archivePath}`);
  return destination;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… truncated …`;
}

function formatMilliseconds(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

const PREVIEW_CSS = `
:root{color-scheme:light;--ink:#24211c;--muted:#6d665b;--paper:#f7f2e8;--line:#d8cdbd;--red:#9b2c2c;--amber:#8a5a00;--panel:#fffdf8}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.62 ui-serif,Georgia,serif}.masthead{display:flex;justify-content:space-between;gap:2rem;padding:2rem clamp(1rem,5vw,5rem);background:#29251f;color:#fff}.masthead h1{max-width:900px;margin:.25rem 0;font-size:clamp(2rem,5vw,4rem);line-height:1.05}.masthead a{color:#ffe2a8}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font:700 .72rem ui-sans-serif,system-ui}.cover{max-width:180px;margin:0}.cover img{display:block;max-width:100%;max-height:220px}.cover.pointer{max-width:260px;overflow-wrap:anywhere}.cover code,figure code{display:block;font-size:.68rem;overflow-wrap:anywhere}.diagnostics{padding:1.2rem clamp(1rem,5vw,5rem);background:#fff3da;border-bottom:1px solid var(--line)}.diagnostics ul{display:grid;gap:.65rem;padding:0;list-style:none}.diagnostic{padding:.8rem 1rem;border-left:5px solid var(--amber);background:var(--panel)}.diagnostic.failure{border-color:var(--red)}.diagnostic span{float:right;text-transform:uppercase;font:700 .68rem ui-sans-serif,system-ui}.diagnostic p{margin:.2rem 0}.layout{display:grid;grid-template-columns:minmax(210px,290px) minmax(0,780px);justify-content:center;gap:3rem;padding:2rem}.chapters{position:sticky;top:1rem;align-self:start;max-height:calc(100vh - 2rem);overflow:auto}.chapters ol{padding-left:1.4rem}.chapters li{margin:.5rem 0}.chapters a{color:#5c3219}.chapters small{display:block;color:var(--muted)}main{min-width:0}.facts{display:grid;grid-template-columns:repeat(5,1fr);gap:.6rem;margin-bottom:2rem}.facts div{padding:.7rem;background:var(--panel);border:1px solid var(--line)}.facts span{display:block;color:var(--muted);font:700 .68rem ui-sans-serif,system-ui;text-transform:uppercase}.facts strong{font-size:1.2rem}.book-content{padding:clamp(1rem,5vw,4rem);background:var(--panel);box-shadow:0 12px 35px #332a1d18}.paragraph{position:relative;margin:0 0 1em}.paragraph-id{position:absolute;right:calc(100% + .7rem);color:#a39889;font:10px ui-monospace,monospace}.chapter-title{margin:2.4rem 0 1.2rem;padding-top:1rem;border-top:1px solid var(--line)}.omission{margin:1.3rem 0;padding:.45rem;text-align:center;color:var(--muted);border-block:1px dashed var(--line);font:italic .8rem ui-sans-serif,system-ui}figure{margin:1.5rem 0;padding:1rem;background:#eee7da}figure img{display:block;max-width:100%;max-height:650px;margin:auto}figcaption{margin-top:.7rem;color:var(--muted)}.image-placeholder{display:grid;min-height:120px;place-items:center;padding:1rem;border:2px dashed #b9ad9d;color:var(--muted);text-align:center}.process{margin-top:2rem}.process pre,details pre{overflow:auto;max-height:420px;padding:1rem;background:#211f1b;color:#f6f1e8;font-size:.75rem}.empty{padding:3rem;background:var(--panel);text-align:center}@media(max-width:800px){.layout{display:block;padding:1rem}.chapters{position:static;max-height:none}.facts{grid-template-columns:repeat(2,1fr)}.paragraph-id{position:static;margin-right:.5rem}.masthead{display:block}.cover{margin-top:1rem}}
`;
