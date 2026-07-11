import { load } from "cheerio";

import { normalizeText } from "./text.ts";
import type { BookMetadata, ParserDiagnostic } from "./types.ts";
import {
  decodeMarkup,
  normalizeArchivePath,
  parseReference,
  type SelectiveZipArchive,
} from "./epub-archive.ts";
import {
  CONTENT_MEDIA_TYPES,
  EpubParseError,
  MAX_CONTENT_ENTRY_BYTES,
  MAX_TOTAL_CONTENT_BYTES,
  deduplicateStrings,
  elementsByLocalName,
  filenameTitle,
  isContentMediaType,
  isImageMediaType,
  localName,
  looksLikeContentPath,
  mediaTypeForPath,
  tokenSet,
  type ManifestItem,
  type PackageData,
  type SpineItem,
} from "./epub-shared.ts";

export function inspectMimetype(
  archive: SelectiveZipArchive,
  diagnostics: ParserDiagnostic[],
): void {
  const mimetypePath = archive.resolve("mimetype");
  if (mimetypePath === null) {
    diagnostics.push({
      bucket: "Other",
      severity: "warning",
      message: "EPUB mimetype entry is missing",
    });
    return;
  }
  const value = decodeMarkup(archive.read(mimetypePath, 256)).trim();
  if (value !== "application/epub+zip") {
    diagnostics.push({
      bucket: "Other",
      severity: "warning",
      message: `Unexpected EPUB mimetype: ${value || "empty"}`,
    });
  }
}

export function parseContainer(markup: string): string {
  const $ = load(markup, { xml: true });
  const rootfiles = elementsByLocalName($, "rootfile").toArray();
  const preferred = rootfiles.find((element) =>
    ($(element).attr("media-type") ?? "").toLocaleLowerCase().includes("oebps-package"),
  );
  const fullPath = $(preferred ?? rootfiles[0]).attr("full-path")?.trim();
  if (!fullPath) {
    throw new EpubParseError("Crash", "EPUB container.xml has no package rootfile");
  }
  return normalizeArchivePath(decodeURIComponentSafely(fullPath));
}

export function parsePackageDocument(
  markup: string,
  opfPath: string,
  sourcePath: string,
  archive: SelectiveZipArchive,
  diagnostics: ParserDiagnostic[],
): PackageData {
  const $ = load(markup, { xml: true });
  const packageElement = elementsByLocalName($, "package").first();
  if (packageElement.length === 0) {
    throw new EpubParseError("Crash", "EPUB package document has no package element");
  }
  const metadataElement = elementsByLocalName($, "metadata").first();
  const metadataDescendants = metadataElement.find("*");
  const metadataText = (name: string): string[] =>
    metadataDescendants
      .filter((_index, element) => localName(element) === name)
      .toArray()
      .map((element) => normalizeText($(element).text()))
      .filter((value) => value.length > 0);

  const metadata: BookMetadata = {
    title: metadataText("title")[0] ?? filenameTitle(sourcePath),
    authors: deduplicateStrings(metadataText("creator")),
  };
  const language = metadataText("language")[0] ?? packageElement.attr("xml:lang")?.trim();
  const identifier = metadataText("identifier")[0];
  if (language) metadata.language = language;
  if (identifier) metadata.identifier = identifier;

  const fixedLayout = metadataDescendants
    .filter((_index, element) => localName(element) === "meta")
    .toArray()
    .some((element) => {
      const meta = $(element);
      const property = (meta.attr("property") ?? meta.attr("name") ?? "").toLocaleLowerCase();
      const value = normalizeText(meta.attr("content") ?? meta.text()).toLocaleLowerCase();
      return (
        (property === "rendition:layout" && value === "pre-paginated") ||
        (property === "fixed-layout" && ["true", "yes", "1"].includes(value))
      );
    });
  if (fixedLayout) {
    throw new EpubParseError("Other", "Fixed-layout EPUBs are outside this parser's scope");
  }

  const manifest: ManifestItem[] = [];
  const manifestById = new Map<string, ManifestItem>();
  elementsByLocalName($, "manifest")
    .first()
    .children()
    .each((_index, element) => {
      if (localName(element) !== "item") return;
      const item = $(element);
      const id = item.attr("id")?.trim() ?? "";
      const href = item.attr("href")?.trim() ?? "";
      if (!id || !href) return;
      const parsedReference = parseReference(opfPath, href);
      const parsed: ManifestItem = {
        id,
        href,
        path: parsedReference.path,
        mediaType: (item.attr("media-type") ?? "").trim().toLocaleLowerCase(),
        properties: tokenSet(item.attr("properties")),
      };
      const fallbackId = item.attr("fallback")?.trim();
      if (fallbackId) parsed.fallbackId = fallbackId;
      manifest.push(parsed);
      if (manifestById.has(id)) {
        diagnostics.push({ bucket: "Other", severity: "warning", message: `Duplicate manifest id: ${id}` });
      } else {
        manifestById.set(id, parsed);
      }
    });
  if (manifest.length === 0) throw new EpubParseError("Crash", "EPUB manifest is empty");

  const spineElement = elementsByLocalName($, "spine").first();
  const spine: SpineItem[] = [];
  spineElement.children().each((_index, element) => {
    if (localName(element) !== "itemref") return;
    const itemref = $(element);
    const idref = itemref.attr("idref")?.trim() ?? "";
    const declared = manifestById.get(idref);
    const resolved = declared ? resolveContentFallback(declared, manifestById) : undefined;
    if (!resolved) {
      diagnostics.push({
        bucket: "Other",
        severity: "failure",
        message: `Spine idref is absent from the manifest: ${idref || "(empty)"}`,
      });
      return;
    }
    spine.push({
      idref,
      item: resolved,
      linear: (itemref.attr("linear") ?? "yes").toLocaleLowerCase() !== "no",
    });
  });
  if (spine.length === 0) throw new EpubParseError("Crash", "EPUB spine is empty");

  let epub2CoverId: string | null = null;
  metadataDescendants
    .filter((_index, element) => localName(element) === "meta")
    .each((_index, element) => {
      const meta = $(element);
      if ((meta.attr("name") ?? "").toLocaleLowerCase() === "cover") {
        epub2CoverId = meta.attr("content")?.trim() ?? null;
      }
    });

  const guideCoverPaths: string[] = [];
  elementsByLocalName($, "guide")
    .first()
    .children()
    .each((_index, element) => {
      if (localName(element) !== "reference") return;
      const reference = $(element);
      if (!tokenSet(reference.attr("type")).has("cover")) return;
      const href = reference.attr("href")?.trim();
      if (!href) return;
      const parsed = parseReference(opfPath, href);
      if (parsed.path !== null) guideCoverPaths.push(parsed.path);
    });

  const navItem = manifest.find((item) => item.properties.has("nav")) ?? null;
  const spineTocId = spineElement.attr("toc")?.trim() ?? null;
  const ncxItem =
    (spineTocId ? manifestById.get(spineTocId) : undefined) ??
    manifest.find((item) => item.mediaType === "application/x-dtbncx+xml") ??
    null;

  for (const item of manifest) {
    if (item.path !== null) item.path = archive.resolve(item.path) ?? item.path;
  }
  return {
    opfPath,
    metadata,
    manifest,
    manifestById,
    spine,
    spineTocId,
    guideCoverPaths,
    epub2CoverId,
    navItem,
    ncxItem,
  };
}

function resolveContentFallback(
  item: ManifestItem,
  manifestById: Map<string, ManifestItem>,
): ManifestItem | undefined {
  const seen = new Set<string>();
  let current: ManifestItem | undefined = item;
  while (current !== undefined && !seen.has(current.id)) {
    if (CONTENT_MEDIA_TYPES.has(current.mediaType) || looksLikeContentPath(current.path ?? current.href)) {
      return current;
    }
    seen.add(current.id);
    current = current.fallbackId ? manifestById.get(current.fallbackId) : undefined;
  }
  return item;
}

export function preloadContentDocuments(
  archive: SelectiveZipArchive,
  packageData: PackageData,
): void {
  const paths = new Set<string>();
  for (const spineItem of packageData.spine) {
    const path = resolveManifestPath(archive, spineItem.item);
    if (path !== null && isContentDocument(spineItem.item, path)) paths.add(path);
  }
  for (const item of [packageData.navItem, packageData.ncxItem]) {
    if (!item?.path) continue;
    const path = archive.resolve(item.path);
    if (path !== null) paths.add(path);
  }
  for (const guidePath of packageData.guideCoverPaths) {
    const path = archive.resolve(guidePath);
    if (path !== null && looksLikeContentPath(path)) paths.add(path);
  }
  archive.readMany(paths, MAX_TOTAL_CONTENT_BYTES);
}

export function resolveManifestPath(
  archive: SelectiveZipArchive,
  item: ManifestItem,
): string | null {
  return item.path ? archive.resolve(item.path) : null;
}

export function isContentDocument(item: ManifestItem, path: string): boolean {
  return isContentMediaType(item.mediaType, path);
}

export function declaredManifestImageCount(packageData: PackageData): number {
  return packageData.manifest.filter((item) =>
    isImageMediaType(item.mediaType, item.path ?? item.href),
  ).length;
}

export function declaredMediaType(path: string, packageData: PackageData): string {
  return mediaTypeForPath(path, packageData) ?? "";
}

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
