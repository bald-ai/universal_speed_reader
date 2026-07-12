import { basename, extname } from "./path.ts";

import { load } from "cheerio";

import { decodeSafeUriComponent, normalizeText } from "./text.ts";
import type {
  BookImage,
  BookMetadata,
  Chapter,
  Cover,
  FailureBucket,
  Paragraph,
  ParserDiagnostic,
} from "./types.ts";
import type { SelectiveZipArchive } from "./epub-archive.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_STRUCTURE_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_CONTENT_ENTRY_BYTES = 48 * 1024 * 1024;
export const MAX_TOTAL_CONTENT_BYTES = 192 * 1024 * 1024;
export const MAX_INLINE_IMAGE_CHARACTERS = 96 * 1024;
export const MAX_SVG_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_STYLESHEET_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_WARNINGS = 30;

export const CONTENT_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "application/xml",
  "text/xml",
]);
export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
export const COVERISH = /(?:^|[\W_])(front[-_ ]?)?cover(?:[\W_]|$)/iu;

export type LoadedDocument = ReturnType<typeof load>;
export type DomNode = ReturnType<LoadedDocument>[number];

export interface ManifestItem {
  id: string;
  href: string;
  path: string | null;
  mediaType: string;
  properties: Set<string>;
  fallbackId?: string;
}

export interface SpineItem {
  idref: string;
  item: ManifestItem;
  linear: boolean;
}

export interface PackageData {
  opfPath: string;
  metadata: BookMetadata;
  manifest: ManifestItem[];
  manifestById: Map<string, ManifestItem>;
  spine: SpineItem[];
  spineTocId: string | null;
  guideCoverPaths: string[];
  epub2CoverId: string | null;
  navItem: ManifestItem | null;
  ncxItem: ManifestItem | null;
}

export interface ResolvedMedia {
  src: string;
  mediaType?: string;
}

export interface ExtractionState {
  archive: SelectiveZipArchive;
  packageData: PackageData;
  paragraphs: Paragraph[];
  images: BookImage[];
  headings: Chapter[];
  fileChapters: Chapter[];
  fileStarts: Map<string, number>;
  anchors: Map<string, number>;
  cover: Cover | null;
  diagnostics: ParserDiagnostic[];
  imageWarningKeys: Set<string>;
  mediaCache: Map<string, ResolvedMedia | null>;
  svgResolutionStack: Set<string>;
  imageKeys: Set<string>;
  contentImageSources: Set<string>;
  contentImageReferences: Set<string>;
  pendingSceneBreakSource: Paragraph["sceneBreakBefore"] | null;
  cssSeparatorElements: Set<DomNode>;
  deadline: number;
  timeoutMs: number;
}

/** A categorized EPUB failure that corpus evaluation can tally directly. */
export class EpubParseError extends Error {
  readonly bucket: FailureBucket;

  constructor(bucket: FailureBucket, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EpubParseError";
    this.bucket = bucket;
  }
}

export function loadDocument(markup: string, path: string, mediaType = ""): LoadedDocument {
  const xml = mediaType === "application/xhtml+xml" || /\.(?:xhtml|xht|xml|svg)$/iu.test(path);
  return load(markup, xml ? { xml: true } : undefined);
}

export function elementsByLocalName($: LoadedDocument, name: string) {
  const expected = name.toLocaleLowerCase();
  return $("*").filter((_index, element) => localName(element) === expected);
}

export function localName(element: unknown): string {
  const name = (element as { name?: unknown }).name;
  if (typeof name !== "string") return "";
  return (name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name).toLocaleLowerCase();
}

export function isContentMediaType(mediaType: string, path: string): boolean {
  return CONTENT_MEDIA_TYPES.has(mediaType) || looksLikeContentPath(path);
}

export function looksLikeContentPath(path: string): boolean {
  return /\.(?:xhtml|xht|html?|xml)$/iu.test(path);
}

export function inferImageMediaType(path: string): string | null {
  const extension = extname(path.split(/[?#]/u, 1)[0] ?? "").toLocaleLowerCase();
  if ([".jpg", ".jpeg", ".jfif"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".svg" || extension === ".svgz") return "image/svg+xml";
  return null;
}

export function normalizeImageMediaType(mediaType: string | null): string | null {
  if (!mediaType) return null;
  const lower = mediaType.toLocaleLowerCase().split(";", 1)[0]?.trim() ?? "";
  return lower === "image/jpg" ? "image/jpeg" : lower;
}

export function isImageMediaType(mediaType: string, path: string): boolean {
  const normalized = normalizeImageMediaType(mediaType);
  return (normalized !== null && SUPPORTED_IMAGE_MEDIA_TYPES.has(normalized)) || inferImageMediaType(path) !== null;
}

export function mediaTypeForPath(path: string, packageData: PackageData): string | null {
  const lower = path.toLocaleLowerCase();
  const item = packageData.manifest.find(
    (candidate) => candidate.path?.toLocaleLowerCase() === lower,
  );
  return normalizeImageMediaType(item?.mediaType ?? null) ?? inferImageMediaType(path);
}

export function toCover(media: ResolvedMedia): Cover {
  const cover: Cover = { src: media.src };
  if (media.mediaType) cover.mediaType = media.mediaType;
  return cover;
}

export function tokenSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean),
  );
}

export function filenameTitle(sourcePath: string): string {
  const filename = basename(sourcePath, extname(sourcePath));
  return normalizeText(filename.replace(/[_-]+/gu, " ")) || "Untitled";
}

export function fileChapterTitle(documentPath: string, index: number): string {
  const filename = basename(documentPath, extname(documentPath));
  const humanized = normalizeText(
    decodeSafeUriComponent(filename)
      .replace(/[_-]+/gu, " ")
      .replace(/\b(?:x?html?|chapter|chap|section|part)\b/giu, " "),
  );
  return isSaneChapterTitle(humanized) ? humanized : `Section ${index + 1}`;
}

export function isSaneChapterTitle(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.length > 0 && normalized.length <= 240 && /[\p{L}\p{N}]/u.test(normalized);
}

export function hasReadableText(value: string): boolean {
  return value.length > 0 && /[\p{L}\p{N}]/u.test(value);
}

export function deduplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
