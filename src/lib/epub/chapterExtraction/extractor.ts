/*
  EPUB CHAPTER EXTRACTION MODULE

  This is the app's dedicated chapter extraction package.
  The goal is to keep the EPUB parsing and chapter calibration logic boxed in one
  place so it can be swapped, moved, or reused without dragging app import code
  around with it.
*/
import { load as loadHtml, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { ProcessingStatus, StoredParagraph } from "@/types/storage";
import { ZipArchive } from "@/lib/epub/zipArchive";
import { tokenizeParagraph } from "@/lib/utils/wordExtraction";

type TocEntry = {
  id: string;
  title: string;
  file: string;
  anchor?: string;
  order: number;
  depth: number;
  parentId: string | null;
  source: "nav" | "ncx";
  category: "main" | "front" | "back" | "unknown";
};

type ParsePhase = Extract<ProcessingStatus, "extracting_metadata" | "extracting_text" | "building_chapters">;

type ParsedChapter = {
  title: string;
  start_paragraph_id: number;
};

type ParsedEpubImage = {
  srcPath: string;
  alt: string | null;
  afterParagraphId: number;
};

type ParsedEpubResult = {
  title: string;
  author: string | null;
  language: string | null;
  coverPath: string | null;
  paragraphs: StoredParagraph[];
  chapters: ParsedChapter[];
  images: ParsedEpubImage[];
  totalWords: number;
  tocEntries: number;
};

type ParseEpubOptions = {
  onPhaseChange?: (phase: ParsePhase) => void | Promise<void>;
  signal?: AbortSignal;
};

type ManifestItem = {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
  resolvedPath: string;
};

type ParsedOpf = {
  title: string;
  author: string | null;
  language: string | null;
  coverPath: string | null;
  spinePaths: string[];
  navPath: string | null;
  ncxPath: string | null;
  guideReferences: StructuralReference[];
};

type ExtractedParagraph = {
  text: string;
  anchors: string[];
};

type ExtractedBlock =
  | ({ kind: "paragraph" } & ExtractedParagraph)
  | { kind: "image"; src: string; alt: string | null };

type StructuralReference = {
  file: string;
  anchor?: string;
  types: string[];
};

type ParsedNavigationDocument = {
  tocEntries: TocEntry[];
  landmarks: StructuralReference[];
};

type TocChapterCandidate = {
  id: string;
  title: string;
  start_paragraph_id: number;
  depth: number;
  order: number;
  category: TocEntry["category"];
};

type ParagraphContext = {
  paragraph: StoredParagraph;
  normalized: string;
  file: string;
  spineIndex: number;
};

type ChapterKind =
  | "front"
  | "back"
  | "letter"
  | "chapter"
  | "numbered"
  | "book"
  | "part"
  | "volume"
  | "act"
  | "scene"
  | "dramatis"
  | "play-section"
  | "other";

const IGNORED_HEADINGS = new Set([
  "document outline",
  "table of contents",
  "contents",
  "toc",
  "copyright",
  "title page",
  "cover",
  "about the author",
  "all rights reserved",
]);

const FRONT_MATTER_TITLES = [
  "cover",
  "title page",
  "half title",
  "contents",
  "table of contents",
  "illustrations",
  "copyright",
  "copyright page",
  "dedication",
  "preface",
  "foreword",
  "introduction",
];

const BACK_MATTER_TITLES = [
  "appendix",
  "appendices",
  "glossary",
  "bibliography",
  "index",
  "notes",
  "footnotes",
  "endnotes",
  "colophon",
  "license",
  "licence",
];

const FRONT_MATTER_TYPES = new Set([
  "cover",
  "title-page",
  "titlepage",
  "halftitlepage",
  "imprint",
  "copyright-page",
  "copyrightpage",
  "toc",
  "dedication",
  "preface",
  "foreword",
]);

const BACK_MATTER_TYPES = new Set([
  "appendix",
  "appendices",
  "glossary",
  "bibliography",
  "index",
  "notes",
  "footnotes",
  "endnotes",
  "colophon",
  "loa",
  "loi",
]);

const MAIN_CONTENT_TYPES = new Set(["bodymatter", "text", "chapter", "part", "volume"]);

function normalizePath(href: string | undefined): string {
  if (!href) return "";
  return href
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^(\.\.\/)+/g, "")
    .replace(/^OEBPS\//i, "")
    .replace(/^OPS\//i, "")
    .toLowerCase();
}

function normalizePathSegments(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function dirname(pathValue: string): string {
  const normalized = normalizePathSegments(pathValue);
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/");
}

function resolveRelativePath(baseFilePath: string, href: string): string {
  if (!href) return normalizePathSegments(baseFilePath);
  const [filePart] = href.split("#");
  if (!filePart) return normalizePathSegments(baseFilePath);
  if (filePart.startsWith("/")) {
    return normalizePathSegments(filePart.replace(/^\/+/, ""));
  }
  const baseDir = dirname(baseFilePath);
  const combined = baseDir ? `${baseDir}/${filePart}` : filePart;
  return normalizePathSegments(combined);
}

function getFilename(href: string | undefined): string {
  if (!href) return "";
  const normalized = normalizePath(href);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

function normalizeForDedup(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeLooseTitle(value: string): string {
  return normalizeForDedup(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesNormalizedTitle(normalizedPara: string, normalizedTitle: string): boolean {
  if (!normalizedPara || !normalizedTitle) return false;
  if (normalizedPara === normalizedTitle) return true;
  if (normalizedPara.startsWith(`${normalizedTitle} `)) return true;
  if (normalizedPara === `${normalizedTitle}.` || normalizedPara === `${normalizedTitle},`) return true;

  if (normalizedPara.length < normalizedTitle.length + 15 && normalizedPara.includes(normalizedTitle)) {
    return true;
  }

  const chapterNumMatch = normalizedTitle.match(/^(\d+)\.\s*(.+)$/);
  if (chapterNumMatch) {
    const [, num, rest] = chapterNumMatch;
    if (normalizedPara === num || normalizedPara === `chapter ${num}` || normalizedPara === rest) {
      return true;
    }
  }

  return false;
}

function textMatchesTitle(paraText: string, tocTitle: string): boolean {
  return matchesNormalizedTitle(normalizeForDedup(paraText), normalizeForDedup(tocTitle));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal) return;
  if (!signal.aborted) return;
  throw new Error("Import aborted");
}

function parseContainerPath(containerXml: string): string {
  const $ = loadHtml(containerXml, { xmlMode: true });
  const rootfilePath = $("rootfile").first().attr("full-path");
  if (!rootfilePath) {
    throw new Error("Corrupted/Unreadable EPUB: container.xml missing OPF rootfile");
  }
  return normalizePathSegments(rootfilePath);
}

function findMetadataText($: CheerioAPI, tagSuffix: string): string | null {
  let output: string | null = null;
  $("metadata")
    .first()
    .children()
    .each((_, node) => {
      if (output) return;
      const tagName = "tagName" in node ? String(node.tagName).toLowerCase() : "";
      if (tagName === tagSuffix || tagName.endsWith(`:${tagSuffix}`)) {
        const text = $(node).text().replace(/\s+/g, " ").trim();
        if (text.length > 0) {
          output = text;
        }
      }
    });
  return output;
}

function parseOpf(opfXml: string, opfPath: string): ParsedOpf {
  const $ = loadHtml(opfXml, { xmlMode: true });
  const title = findMetadataText($, "title") ?? "Untitled";
  const author = findMetadataText($, "creator");
  const language = findMetadataText($, "language");

  const manifestById = new Map<string, ManifestItem>();
  $("manifest item").each((_, node) => {
    const id = $(node).attr("id");
    const href = $(node).attr("href");
    if (!id || !href) return;
    const mediaType = $(node).attr("media-type") ?? "";
    const properties = $(node).attr("properties") ?? "";
    manifestById.set(id, {
      id,
      href,
      mediaType,
      properties,
      resolvedPath: resolveRelativePath(opfPath, href),
    });
  });

  const spinePaths: string[] = [];
  const guideReferences: StructuralReference[] = [];
  const tocId = $("spine").first().attr("toc") ?? null;
  $("spine itemref").each((_, node) => {
    const idref = $(node).attr("idref");
    if (!idref) return;
    const item = manifestById.get(idref);
    if (!item) return;
    spinePaths.push(item.resolvedPath);
  });

  const navItem =
    [...manifestById.values()].find((item) =>
      item.properties
        .split(/\s+/)
        .map((value) => value.trim().toLowerCase())
        .includes("nav")
    ) ??
    [...manifestById.values()].find((item) => item.id.toLowerCase().includes("nav")) ??
    null;

  const ncxItem =
    (tocId ? manifestById.get(tocId) : null) ??
    [...manifestById.values()].find((item) => item.mediaType === "application/x-dtbncx+xml") ??
    null;

  let coverPath: string | null = null;
  const coverId = $('metadata meta[name="cover"]').first().attr("content");
  if (coverId && manifestById.has(coverId)) {
    coverPath = manifestById.get(coverId)?.resolvedPath ?? null;
  }
  if (!coverPath) {
    const coverItem = [...manifestById.values()].find((item) => item.mediaType.startsWith("image/"));
    coverPath = coverItem?.resolvedPath ?? null;
  }

  if (spinePaths.length === 0) {
    throw new Error("Corrupted/Unreadable EPUB: OPF spine is empty");
  }

  $("guide reference").each((_, node) => {
    const href = $(node).attr("href");
    const type = $(node).attr("type");
    if (!href || !type) return;
    const [filePart, anchorPart] = href.split("#");
    const resolvedFile = resolveRelativePath(opfPath, filePart || href);
    const types = type
      .split(/\s+/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    if (types.length === 0) return;
    guideReferences.push({
      file: normalizePath(resolvedFile),
      anchor: anchorPart || undefined,
      types,
    });
  });

  return {
    title,
    author,
    language,
    coverPath,
    spinePaths,
    navPath: navItem?.resolvedPath ?? null,
    ncxPath: ncxItem?.resolvedPath ?? null,
    guideReferences,
  };
}

function collectNavEntries(
  $: CheerioAPI,
  list: Cheerio<AnyNode>,
  navPath: string,
  depth: number,
  parentId: string | null,
  entries: TocEntry[],
  orderRef: { value: number }
): void {
  list.children("li").each((_, node) => {
    const item = $(node);
    const directLink = item.children("a[href]").first();
    const fallbackLink = directLink.length > 0 ? directLink : item.find("a[href]").first();
    let currentParentId = parentId;

    if (fallbackLink.length > 0) {
      const href = fallbackLink.attr("href");
      const text = fallbackLink.text().replace(/\s+/g, " ").trim();
      if (href && text) {
        const [filePart, anchorPart] = href.split("#");
        const resolvedFile = filePart ? resolveRelativePath(navPath, filePart) : normalizePathSegments(navPath);
        const entryId = `nav-${orderRef.value}`;
        entries.push({
          id: entryId,
          title: text,
          file: normalizePath(resolvedFile),
          anchor: anchorPart || undefined,
          order: orderRef.value,
          depth,
          parentId,
          source: "nav",
          category: "unknown",
        });
        currentParentId = entryId;
        orderRef.value += 1;
      }
    }

    item.children("ol, ul").each((__, childList) => {
      collectNavEntries($, $(childList), navPath, depth + 1, currentParentId, entries, orderRef);
    });
  });
}

function parseTocFromNav(navHtml: string, navPath: string): TocEntry[] {
  const $ = loadHtml(navHtml);
  const rootNav = $('nav[epub\\:type="toc"], nav[type="toc"]').first();
  const entries: TocEntry[] = [];
  const orderRef = { value: 0 };
  const rootList = rootNav.find("> ol, > ul").first();
  collectNavEntries($, rootList.length > 0 ? rootList : rootNav, navPath, 1, null, entries, orderRef);
  return entries;
}

function collectNcxEntries(
  $: CheerioAPI,
  nodes: Cheerio<AnyNode>,
  ncxPath: string,
  depth: number,
  parentId: string | null,
  entries: TocEntry[],
  orderRef: { value: number }
): void {
  nodes.each((_, node) => {
    const item = $(node);
    const title = item.find("> navLabel > text").first().text().replace(/\s+/g, " ").trim();
    const src = item.find("> content").first().attr("src");
    let currentParentId = parentId;

    if (title && src) {
      const [filePart, anchorPart] = src.split("#");
      const resolvedFile = resolveRelativePath(ncxPath, filePart);
      const entryId = `ncx-${orderRef.value}`;
      entries.push({
        id: entryId,
        title,
        file: normalizePath(resolvedFile),
        anchor: anchorPart || undefined,
        order: orderRef.value,
        depth,
        parentId,
        source: "ncx",
        category: "unknown",
      });
      currentParentId = entryId;
      orderRef.value += 1;
    }

    const childNavPoints = item.children("navPoint");
    if (childNavPoints.length > 0) {
      collectNcxEntries($, childNavPoints, ncxPath, depth + 1, currentParentId, entries, orderRef);
    }
  });
}

function parseTocFromNcx(ncxXml: string, ncxPath: string): TocEntry[] {
  const $ = loadHtml(ncxXml, { xmlMode: true });
  const entries: TocEntry[] = [];
  const orderRef = { value: 0 };
  collectNcxEntries($, $("navMap").children("navPoint"), ncxPath, 1, null, entries, orderRef);
  return entries;
}

function parseLandmarksFromNav(navHtml: string, navPath: string): StructuralReference[] {
  const $ = loadHtml(navHtml);
  const rootNav = $('nav[epub\\:type="landmarks"], nav[type="landmarks"]').first();
  const landmarks: StructuralReference[] = [];

  rootNav.find("a[href]").each((_, node) => {
    const href = $(node).attr("href");
    if (!href) return;
    const [filePart, anchorPart] = href.split("#");
    const resolvedFile = filePart ? resolveRelativePath(navPath, filePart) : normalizePathSegments(navPath);
    const types = ($(node).attr("epub:type") ?? $(node).attr("type") ?? "")
      .split(/\s+/)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    if (types.length === 0) return;
    landmarks.push({
      file: normalizePath(resolvedFile),
      anchor: anchorPart || undefined,
      types,
    });
  });

  return landmarks;
}

function parseNavigationDocument(navHtml: string, navPath: string): ParsedNavigationDocument {
  return {
    tocEntries: parseTocFromNav(navHtml, navPath),
    landmarks: parseLandmarksFromNav(navHtml, navPath),
  };
}

function mergeTocEntries(...groups: TocEntry[][]): TocEntry[] {
  const merged: TocEntry[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const entry of group) {
      const key = `${entry.file}#${entry.anchor ?? ""}::${normalizeForDedup(entry.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function collectAnchors($: CheerioAPI, node: AnyNode, seenIds: Set<string>): string[] {
  const element = $(node);
  const anchors: string[] = [];

  const addAnchor = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed || seenIds.has(trimmed)) return;
    seenIds.add(trimmed);
    anchors.push(trimmed);
  };

  addAnchor(element.attr("id"));
  addAnchor(element.attr("name"));

  element.find("[id], [name]").each((_, child) => {
    addAnchor($(child).attr("id"));
    addAnchor($(child).attr("name"));
  });

  const parent = element.parent();
  if (parent.length > 0) {
    addAnchor(parent.attr("id"));
    addAnchor(parent.attr("name"));
  }

  const addNestedAnchors = (target: Cheerio<AnyNode>) => {
    target.find("[id], [name]").each((_, child) => {
      addAnchor($(child).attr("id"));
      addAnchor($(child).attr("name"));
    });
  };

  let previous = element.prev();
  while (previous.length > 0 && previous.text().trim() === "") {
    addAnchor(previous.attr("id"));
    addAnchor(previous.attr("name"));
    addNestedAnchors(previous);
    previous = previous.prev();
  }

  return anchors;
}

function extractHeadingFromChapter($: CheerioAPI): string | null {
  const candidate = $("h1, h2, h3, h4, header h1, header h2, .chapter-title, .title")
    .map((_, node) => $(node).text())
    .get()
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find((text) => text.length > 0 && !IGNORED_HEADINGS.has(text.toLowerCase()));
  return candidate ?? null;
}

function buildDocumentOrderMap($: CheerioAPI): Map<AnyNode, number> {
  const orderByNode = new Map<AnyNode, number>();
  let nextOrder = 0;

  const walk = (nodes: AnyNode[]) => {
    for (const node of nodes) {
      orderByNode.set(node, nextOrder);
      nextOrder += 1;
      if ("children" in node && Array.isArray(node.children)) {
        walk(node.children as AnyNode[]);
      }
    }
  };

  const root = $.root()[0];
  if (root && "children" in root && Array.isArray(root.children)) {
    walk(root.children as AnyNode[]);
  }
  return orderByNode;
}

function serializeInlineSvg($: CheerioAPI, node: AnyNode): string | null {
  const element = $(node);
  if (!element.is("svg")) return null;

  // Ensure standalone SVG data URLs render when used as <img src>.
  if (!element.attr("xmlns")) {
    element.attr("xmlns", "http://www.w3.org/2000/svg");
  }

  const markup = $.html(element)?.trim();
  if (!markup) return null;

  try {
    if (typeof btoa === "function") {
      const bytes = new TextEncoder().encode(markup);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]!);
      }
      return `data:image/svg+xml;base64,${btoa(binary)}`;
    }
  } catch {
    // Fall through to URL-encoded form.
  }

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function extractBlocksFromChapter(html: string): ExtractedBlock[] {
  const $ = loadHtml(html, { xmlMode: false });
  $("script, style, noscript, title").remove();
  const documentOrder = buildDocumentOrderMap($);
  const seenIds = new Set<string>();

  type OrderedBlock = { order: number; block: ExtractedBlock };
  const ordered: OrderedBlock[] = [];

  $("img").each((_, node) => {
    const element = $(node);
    const src = (element.attr("src") ?? "").trim();
    if (!src) return;
    const altRaw = (element.attr("alt") ?? "").trim();
    ordered.push({
      order: documentOrder.get(node) ?? ordered.length,
      block: {
        kind: "image",
        src,
        alt: altRaw.length > 0 ? altRaw : null,
      },
    });
  });

  // Top-level SVG figures only (skip nested svg inside another svg).
  $("svg").each((_, node) => {
    const element = $(node);
    if (element.parents("svg").length > 0) return;
    const src = serializeInlineSvg($, node);
    if (!src) return;
    const title = element.find("title").first().text().replace(/\s+/g, " ").trim();
    const ariaLabel = (element.attr("aria-label") ?? "").trim();
    const alt = title || ariaLabel || null;
    ordered.push({
      order: documentOrder.get(node) ?? ordered.length,
      block: {
        kind: "image",
        src,
        alt,
      },
    });
  });

  // Remove SVGs before paragraph extraction so decorative SVG text does not leak.
  $("svg").remove();

  $("p, div, li, h1, h2, h3, h4, h5, h6").each((_, node) => {
    const element = $(node);
    const normalized = element.text().replace(/\s+/g, " ").trim();
    if (normalized.length < 2) return;
    if (normalized.includes("{") && normalized.includes("}")) return;
    if (element.find("p, div, li").length > 0 && element.is("div")) return;
    ordered.push({
      order: documentOrder.get(node) ?? ordered.length,
      block: {
        kind: "paragraph",
        text: normalized,
        anchors: collectAnchors($, node, seenIds),
      },
    });
  });

  ordered.sort((a, b) => a.order - b.order);

  if (ordered.every((entry) => entry.block.kind !== "paragraph")) {
    const rootText = $.root().text().replace(/\s+/g, " ").trim();
    if (rootText.length >= 2) {
      ordered.unshift({
        order: -1,
        block: { kind: "paragraph", text: rootText, anchors: [] },
      });
    }
  }

  return ordered.map((entry) => entry.block);
}

function extractParagraphsFromChapter(html: string): ExtractedParagraph[] {
  return extractBlocksFromChapter(html)
    .filter((block): block is ExtractedParagraph & { kind: "paragraph" } => block.kind === "paragraph")
    .map(({ text, anchors }) => ({ text, anchors }));
}

function buildReferenceTypeIndex(references: StructuralReference[]) {
  const byTarget = new Map<string, Set<string>>();
  const byFile = new Map<string, Set<string>>();

  for (const reference of references) {
    const normalizedFile = normalizePath(reference.file);
    const targetKey = `${normalizedFile}#${(reference.anchor ?? "").toLowerCase()}`;
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, new Set<string>());
    if (!byFile.has(normalizedFile)) byFile.set(normalizedFile, new Set<string>());
    for (const type of reference.types) {
      byTarget.get(targetKey)?.add(type);
      byFile.get(normalizedFile)?.add(type);
    }
  }

  return { byTarget, byFile };
}

function classifyTocEntry(
  entry: TocEntry,
  referenceTypeIndex: ReturnType<typeof buildReferenceTypeIndex>,
  normalizedBookTitle: string
): TocEntry["category"] {
  const normalizedTitle = normalizeForDedup(entry.title);
  const normalizedMatterTitle = normalizedTitle.replace(/[:.;,]+$/g, "");
  const targetKey = `${entry.file}#${(entry.anchor ?? "").toLowerCase()}`;
  const types = new Set<string>([
    ...(referenceTypeIndex.byTarget.get(targetKey) ?? []),
    ...(referenceTypeIndex.byFile.get(entry.file) ?? []),
  ]);

  for (const type of types) {
    if (MAIN_CONTENT_TYPES.has(type)) return "main";
    if (FRONT_MATTER_TYPES.has(type)) return "front";
    if (BACK_MATTER_TYPES.has(type)) return "back";
  }

  if (normalizedTitle === normalizedBookTitle && entry.order <= 2) return "front";
  if (FRONT_MATTER_TITLES.some((title) => normalizedMatterTitle === title || normalizedMatterTitle.startsWith(`${title} `))) {
    return "front";
  }
  if (BACK_MATTER_TITLES.some((title) => normalizedMatterTitle === title || normalizedMatterTitle.startsWith(`${title} `))) {
    return "back";
  }

  return "unknown";
}

function buildTocLookups(tocEntries: TocEntry[]) {
  const tocAnchorMapByFile = new Map<string, Map<string, TocEntry[]>>();
  const tocAnchorMapByUniqueFilename = new Map<string, Map<string, TocEntry[]>>();
  const tocFileMapByFile = new Map<string, TocEntry[]>();
  const tocFileMapByUniqueFilename = new Map<string, TocEntry[]>();
  const filenameCounts = new Map<string, number>();

  for (const entry of tocEntries) {
    const filename = getFilename(entry.file);
    filenameCounts.set(filename, (filenameCounts.get(filename) ?? 0) + 1);
  }

  for (const entry of tocEntries) {
    const normalizedFile = normalizePath(entry.file);
    const filename = getFilename(entry.file);
    const canUseFilenameFallback = (filenameCounts.get(filename) ?? 0) === 1;

    if (entry.anchor) {
      const normalizedAnchor = entry.anchor.toLowerCase();

      if (!tocAnchorMapByFile.has(normalizedFile)) {
        tocAnchorMapByFile.set(normalizedFile, new Map<string, TocEntry[]>());
      }
      const fileAnchorEntries = tocAnchorMapByFile.get(normalizedFile);
      const fileMatches = fileAnchorEntries?.get(normalizedAnchor) ?? [];
      fileMatches.push(entry);
      fileAnchorEntries?.set(normalizedAnchor, fileMatches);

      if (canUseFilenameFallback) {
        if (!tocAnchorMapByUniqueFilename.has(filename)) {
          tocAnchorMapByUniqueFilename.set(filename, new Map<string, TocEntry[]>());
        }
        const filenameAnchorEntries = tocAnchorMapByUniqueFilename.get(filename);
        const filenameMatches = filenameAnchorEntries?.get(normalizedAnchor) ?? [];
        filenameMatches.push(entry);
        filenameAnchorEntries?.set(normalizedAnchor, filenameMatches);
      }
      continue;
    }

    const fileEntries = tocFileMapByFile.get(normalizedFile) ?? [];
    fileEntries.push(entry);
    tocFileMapByFile.set(normalizedFile, fileEntries);
    if (canUseFilenameFallback) {
      const filenameEntries = tocFileMapByUniqueFilename.get(filename) ?? [];
      filenameEntries.push(entry);
      tocFileMapByUniqueFilename.set(filename, filenameEntries);
    }
  }

  return {
    tocAnchorMapByFile,
    tocAnchorMapByUniqueFilename,
    tocFileMapByFile,
    tocFileMapByUniqueFilename,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function classifyChapterKind(title: string, bookTitle: string): ChapterKind {
  const normalizedTitle = normalizeForDedup(title);
  const normalizedMatterTitle = normalizedTitle.replace(/[:.;,]+$/g, "");
  const normalizedBookTitle = normalizeForDedup(bookTitle);
  const looseTitle = normalizeLooseTitle(title);
  const looseBookTitle = normalizeLooseTitle(bookTitle);
  const bookLooksComposite = /[;:/]/.test(bookTitle) || /\band other\b/i.test(bookTitle);
  const trimmedTitle = title.trim();
  const isAllCapsStandalone =
    trimmedTitle.length > 0 &&
    trimmedTitle === trimmedTitle.toUpperCase() &&
    /[A-Z]/.test(trimmedTitle);

  if (/^\[\s*[A-Z]\s*\]$/.test(title.trim())) {
    return "front";
  }

  if (
    normalizedTitle.includes("project gutenberg") ||
    normalizedTitle.includes("full license") ||
    normalizedTitle.includes("copyright") ||
    normalizedTitle === "the end" ||
    normalizedTitle === "finis"
  ) {
    return "back";
  }

  if (
    FRONT_MATTER_TITLES.some((value) => normalizedMatterTitle === value || normalizedMatterTitle.startsWith(`${value} `)) ||
    normalizedTitle.startsWith("illustrated by ") ||
    normalizedTitle.startsWith("translated from ") ||
    normalizedTitle.startsWith("translated by ") ||
    normalizedTitle.startsWith("bibliographical note") ||
    normalizedTitle.startsWith("original short stories") ||
    normalizedTitle.includes("short stories") ||
    normalizedTitle === "prologue" ||
    normalizedTitle === "the prologue" ||
    normalizedTitle === "epilogue" ||
    normalizedTitle === "or"
  ) {
    return "front";
  }

  if (
    !isAllCapsStandalone &&
    !bookLooksComposite &&
    normalizedTitle.length >= 5 &&
    (normalizedBookTitle === normalizedTitle ||
      normalizedBookTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedBookTitle) ||
      looseBookTitle === looseTitle ||
      looseBookTitle.includes(looseTitle) ||
      looseTitle.includes(looseBookTitle))
  ) {
    return "front";
  }

  if (/^letter\b/.test(normalizedTitle)) return "letter";
  if (/^chapter\b/.test(normalizedTitle)) return "chapter";
  if (/^book\b/.test(normalizedTitle)) return "book";
  if (/^part\b/.test(normalizedTitle)) return "part";
  if (/^(volume|vol\.)\b/.test(normalizedTitle)) return "volume";
  if (/^(first|second|third|fourth|fifth)\s+act\b/.test(normalizedTitle)) return "act";
  if (/^act\b/.test(normalizedTitle)) return "act";
  if (/^scene\b/.test(normalizedTitle)) return "scene";
  if (/^dramatis person/.test(normalizedTitle)) return "dramatis";
  if (/^(prologue|epilogue|induction)\b/.test(normalizedTitle)) return "play-section";
  if (/^([ivxlcdm]+|\d+)\b[.\-—: ]+\S/i.test(title)) return "numbered";

  return "other";
}

function isPrimaryNarrativeKind(kind: ChapterKind): boolean {
  return kind === "letter" || kind === "chapter" || kind === "numbered";
}

function looksLikeTitleFragment(title: string, bookTitle: string): boolean {
  const normalizedTitle = normalizeForDedup(title);
  const normalizedBookTitle = normalizeForDedup(bookTitle);
  const looseTitle = normalizeLooseTitle(title);
  const looseBookTitle = normalizeLooseTitle(bookTitle);
  const bookLooksComposite = /[;:/]/.test(bookTitle) || /\band other\b/i.test(bookTitle);
  const trimmedTitle = title.trim();
  const isAllCapsStandalone =
    trimmedTitle.length > 0 &&
    trimmedTitle === trimmedTitle.toUpperCase() &&
    /[A-Z]/.test(trimmedTitle);

  if (isAllCapsStandalone) {
    return false;
  }

  return (
    normalizedTitle === "or" ||
    normalizedTitle === "of" ||
    normalizedTitle.startsWith("or, ") ||
    normalizedTitle.startsWith("and ") ||
    normalizedTitle.startsWith("by ") ||
    normalizedTitle.startsWith("given in ") ||
    (!bookLooksComposite &&
      normalizedTitle.length >= 5 &&
      (normalizedBookTitle.includes(normalizedTitle) ||
        looseBookTitle.includes(looseTitle) ||
        looseTitle.includes(looseBookTitle)))
  );
}

function scoreSharedStartTitle(title: string, bookTitle: string): number {
  const kind = classifyChapterKind(title, bookTitle);
  const normalizedTitle = normalizeForDedup(title);
  let score = 0;

  switch (kind) {
    case "chapter":
      score += 90;
      break;
    case "letter":
      score += 85;
      break;
    case "numbered":
      score += 75;
      break;
    case "other":
      score += 60;
      break;
    case "book":
      score += 45;
      break;
    case "part":
      score += 35;
      break;
    case "volume":
      score += 25;
      break;
    case "act":
      score += 40;
      break;
    case "scene":
      score += 5;
      break;
    case "dramatis":
    case "play-section":
      score += 15;
      break;
    case "front":
    case "back":
      score -= 50;
      break;
  }

  if (normalizedTitle.startsWith("by ") || normalizedTitle.startsWith("or, ")) {
    score -= 10;
  }
  if (normalizedTitle.length < 4) {
    score -= 10;
  }

  return score;
}

function chooseBestPerStart(chapters: ParsedChapter[], bookTitle: string): ParsedChapter[] {
  const bestByStart = new Map<number, ParsedChapter>();

  for (const chapter of chapters) {
    const previous = bestByStart.get(chapter.start_paragraph_id);
    if (!previous) {
      bestByStart.set(chapter.start_paragraph_id, chapter);
      continue;
    }

    const previousScore = scoreSharedStartTitle(previous.title, bookTitle);
    const nextScore = scoreSharedStartTitle(chapter.title, bookTitle);
    if (nextScore > previousScore || (nextScore === previousScore && chapter.title.length > previous.title.length)) {
      bestByStart.set(chapter.start_paragraph_id, chapter);
    }
  }

  return [...bestByStart.values()].sort((a, b) => a.start_paragraph_id - b.start_paragraph_id);
}

function removeNearbyContainerEntries(chapters: ParsedChapter[], bookTitle: string): ParsedChapter[] {
  const kindCounts = new Map<ChapterKind, number>();
  for (const chapter of chapters) {
    const kind = classifyChapterKind(chapter.title, bookTitle);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }

  const primaryNarrativeCount =
    (kindCounts.get("chapter") ?? 0) +
    (kindCounts.get("letter") ?? 0) +
    (kindCounts.get("numbered") ?? 0);
  const dominantOtherCount = kindCounts.get("other") ?? 0;

  return chapters.filter((chapter, index) => {
    const kind = classifyChapterKind(chapter.title, bookTitle);
    const next = chapters[index + 1];
    const nextKind = next ? classifyChapterKind(next.title, bookTitle) : null;
    const nextGap = next ? next.start_paragraph_id - chapter.start_paragraph_id : Number.MAX_SAFE_INTEGER;

    if (kind === "front" || kind === "back") {
      return false;
    }

    if (
      (kind === "part" || kind === "book" || kind === "volume") &&
      next &&
      nextGap <= 3 &&
      nextKind !== null &&
      (isPrimaryNarrativeKind(nextKind) || nextKind === "other")
    ) {
      if (kind === "volume" || primaryNarrativeCount >= 5) {
        return false;
      }
    }

    if (
      (kind === "act" || kind === "scene" || kind === "dramatis" || kind === "play-section") &&
      dominantOtherCount >= 5
    ) {
      return false;
    }

    return true;
  });
}

function dropPreludeBeforePrimaryChapters(chapters: ParsedChapter[], bookTitle: string): ParsedChapter[] {
  const firstPrimaryIndex = chapters.findIndex((chapter) =>
    isPrimaryNarrativeKind(classifyChapterKind(chapter.title, bookTitle))
  );
  if (firstPrimaryIndex <= 0 || firstPrimaryIndex > 3) return chapters;

  return chapters.filter((chapter, index) => {
    if (index >= firstPrimaryIndex) return true;
    return isPrimaryNarrativeKind(classifyChapterKind(chapter.title, bookTitle));
  });
}

function dropEarlyWrapperEntries(chapters: ParsedChapter[], bookTitle: string): ParsedChapter[] {
  const remaining = [...chapters];

  while (remaining.length >= 2) {
    const first = remaining[0]!;
    const second = remaining[1]!;
    const gap = second.start_paragraph_id - first.start_paragraph_id;
    const firstKind = classifyChapterKind(first.title, bookTitle);
    const firstNormalized = normalizeForDedup(first.title);
    const secondKind = classifyChapterKind(second.title, bookTitle);

    if (
      firstKind === "front" ||
      firstKind === "back" ||
      looksLikeTitleFragment(first.title, bookTitle) ||
      (gap <= 12 &&
        firstKind === "other" &&
        secondKind === "other" &&
        /\b(trilogy|poems|plays|stories|essays|works)\b/.test(firstNormalized)) ||
      (gap <= 10 && firstKind === "other" && looksLikeTitleFragment(first.title, bookTitle))
    ) {
      remaining.shift();
      continue;
    }

    break;
  }

  return remaining;
}

function shiftChapterStartsPastHeadings(chapters: ParsedChapter[], paragraphs: StoredParagraph[]): ParsedChapter[] {
  return chapters.map((chapter, index) => {
    const currentParagraph = paragraphs[chapter.start_paragraph_id - 1];
    const nextParagraph = paragraphs[chapter.start_paragraph_id];
    const nextChapterStart = chapters[index + 1]?.start_paragraph_id ?? Number.MAX_SAFE_INTEGER;

    if (!currentParagraph || !nextParagraph) return chapter;
    if (chapter.start_paragraph_id + 1 >= nextChapterStart) return chapter;

    const currentNormalized = normalizeForDedup(currentParagraph.text);
    const titleNormalized = normalizeForDedup(chapter.title);
    const nextNormalized = normalizeForDedup(nextParagraph.text);

    const currentLooksLikeHeading =
      currentNormalized === titleNormalized ||
      matchesNormalizedTitle(currentNormalized, titleNormalized) ||
      (currentParagraph.text.length <= 80 && currentParagraph.text === currentParagraph.text.toUpperCase());
    const nextLooksLikeBody =
      nextNormalized !== titleNormalized &&
      nextParagraph.text.trim().length >= 2;

    if (currentLooksLikeHeading && nextLooksLikeBody) {
      return {
        title: chapter.title,
        start_paragraph_id: chapter.start_paragraph_id + 1,
      };
    }

    return chapter;
  });
}

function removeSongCompanionEntries(chapters: ParsedChapter[]): ParsedChapter[] {
  return chapters.filter((chapter, index) => {
    const normalizedTitle = normalizeForDedup(chapter.title);
    const isSongLike = normalizedTitle.includes("song") || normalizedTitle.includes("chant");
    if (!isSongLike) return true;

    const previous = chapters[index - 1];
    const next = chapters[index + 1];
    const previousGap = previous ? chapter.start_paragraph_id - previous.start_paragraph_id : Number.MAX_SAFE_INTEGER;
    const nextGap = next ? next.start_paragraph_id - chapter.start_paragraph_id : Number.MAX_SAFE_INTEGER;
    const previousIsSongLike = previous
      ? normalizeForDedup(previous.title).includes("song") || normalizeForDedup(previous.title).includes("chant")
      : false;
    const nextIsSongLike = next
      ? normalizeForDedup(next.title).includes("song") || normalizeForDedup(next.title).includes("chant")
      : false;

    if (next && nextGap <= 2 && !nextIsSongLike) {
      return false;
    }
    if (previous && previousGap <= 2 && !previousIsSongLike) {
      return false;
    }

    return true;
  });
}

function findFirstBodyParagraphStart(
  paragraphs: StoredParagraph[],
  bookTitle: string,
  author: string | null
): number {
  const normalizedBookTitle = normalizeForDedup(bookTitle);
  const normalizedAuthor = author ? normalizeForDedup(author) : null;

  for (const paragraph of paragraphs) {
    const normalized = normalizeForDedup(paragraph.text);
    if (!normalized) continue;
    if (normalized.startsWith("the project gutenberg ebook of ")) continue;
    if (normalized.startsWith("title: ")) continue;
    if (normalized.startsWith("author: ")) continue;
    if (normalized.startsWith("translator: ")) continue;
    if (normalized.startsWith("release date: ")) continue;
    if (normalized.startsWith("language: ")) continue;
    if (normalized.startsWith("other information and formats: ")) continue;
    if (normalized.startsWith("credits: ")) continue;
    if (normalized.startsWith("*** start of the project gutenberg ebook")) continue;
    if (normalized.startsWith("*** end of the project gutenberg ebook")) continue;
    if (normalized.includes("project gutenberg")) continue;
    if (normalized === normalizedBookTitle) continue;
    if (normalizedAuthor && (normalized === `by ${normalizedAuthor}` || normalized.includes(`by ${normalizedAuthor}`))) {
      continue;
    }
    return paragraph.id;
  }

  return 1;
}

function normalizeSingleChapterOutput(
  chapters: ParsedChapter[],
  paragraphs: StoredParagraph[],
  bookTitle: string,
  author: string | null
): ParsedChapter[] {
  if (chapters.length !== 1 || paragraphs.length === 0) return chapters;

  const only = chapters[0]!;
  const normalizedTitle = normalizeForDedup(only.title);
  const normalizedAuthor = author ? normalizeForDedup(author) : null;
  const looksWrong =
    classifyChapterKind(only.title, bookTitle) === "front" ||
    classifyChapterKind(only.title, bookTitle) === "back" ||
    looksLikeTitleFragment(only.title, bookTitle) ||
    normalizedTitle === "the end" ||
    normalizedTitle === "frederick warne" ||
    (normalizedAuthor !== null && (normalizedTitle === normalizedAuthor || normalizedTitle.includes(normalizedAuthor)));

  if (!looksWrong) return chapters;

  return [{
    title: bookTitle || "Full book",
    start_paragraph_id: findFirstBodyParagraphStart(paragraphs, bookTitle, author),
  }];
}

function isLikelyTopMatterTitle(title: string, bookTitle: string): boolean {
  const kind = classifyChapterKind(title, bookTitle);
  return kind === "front" || kind === "back" || looksLikeTitleFragment(title, bookTitle);
}

function isReferenceStyleTitle(title: string): boolean {
  const normalized = normalizeForDedup(title);
  return (
    /^section \d+\b/.test(normalized) ||
    /^year: \d{4}\b/.test(normalized) ||
    normalized === "top" ||
    normalized.startsWith("the full project gutenberg")
  );
}

function scoreTocParagraphMatch(
  entry: TocEntry,
  context: ParagraphContext,
  totalParagraphs: number,
  bookTitle: string
): number {
  const titleNormalized = normalizeForDedup(entry.title);
  const paragraphNormalized = context.normalized;
  if (!matchesNormalizedTitle(paragraphNormalized, titleNormalized)) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  const sameFile = context.file === entry.file;
  const exact = paragraphNormalized === titleNormalized;
  const startsWithTitle = paragraphNormalized.startsWith(`${titleNormalized} `);
  const kind = classifyChapterKind(entry.title, bookTitle);

  if (sameFile) score += 90;
  if (exact) score += 55;
  if (startsWithTitle) score += 25;
  if (context.paragraph.text.length <= entry.title.length + 24) score += 10;
  if (context.paragraph.id <= Math.max(20, Math.floor(totalParagraphs * 0.05))) score -= 30;
  if (isPrimaryNarrativeKind(kind)) score += 20;
  if (kind === "other") score += 10;
  if (kind === "front" || kind === "back") score -= 60;
  if (sameFile && context.spineIndex > 0) score += 10;

  return score;
}

function recoverCollapsedTocCandidates(
  tocEntries: TocEntry[],
  paragraphContexts: ParagraphContext[],
  bookTitle: string
): TocChapterCandidate[] {
  if (tocEntries.length === 0 || paragraphContexts.length === 0) return [];

  const recovered: TocChapterCandidate[] = [];

  for (const entry of tocEntries) {
    if (entry.category === "front" || entry.category === "back") continue;
    if (isLikelyTopMatterTitle(entry.title, bookTitle)) continue;
    if (isReferenceStyleTitle(entry.title)) continue;

    let bestContext: ParagraphContext | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const context of paragraphContexts) {
      const score = scoreTocParagraphMatch(entry, context, paragraphContexts.length, bookTitle);
      if (score > bestScore) {
        bestScore = score;
        bestContext = context;
      }
    }

    if (!bestContext || !Number.isFinite(bestScore)) continue;
    recovered.push({
      id: `${entry.id}::recovered`,
      title: entry.title,
      start_paragraph_id: bestContext.paragraph.id,
      depth: entry.depth,
      order: entry.order,
      category: entry.category,
    });
  }

  return recovered;
}

function recoverRepeatedTopLevelWorkCandidates(
  tocEntries: TocEntry[],
  firstParagraphIdByFile: Map<string, number>,
  bookTitle: string
): TocChapterCandidate[] {
  const candidateEntries = tocEntries.filter((entry) => {
    if (entry.category === "front" || entry.category === "back") return false;
    if (isLikelyTopMatterTitle(entry.title, bookTitle)) return false;
    if (isReferenceStyleTitle(entry.title)) return false;
    return classifyChapterKind(entry.title, bookTitle) === "other";
  });
  if (candidateEntries.length < 2) return [];

  const shallowestDepth = Math.min(...candidateEntries.map((entry) => entry.depth));
  const topLevelEntries = candidateEntries.filter((entry) => entry.depth === shallowestDepth);
  const grouped = new Map<string, TocEntry[]>();
  for (const entry of topLevelEntries) {
    const normalized = normalizeForDedup(entry.title);
    const existing = grouped.get(normalized) ?? [];
    existing.push(entry);
    grouped.set(normalized, existing);
  }

  const repeatedEntries = [...grouped.values()]
    .filter((group) => group.length >= 2)
    .map((group) => [...group].sort((a, b) => b.order - a.order)[0]!);
  if (repeatedEntries.length < 2) return [];

  const recovered: TocChapterCandidate[] = [];
  for (const entry of repeatedEntries) {
    const startParagraphId = firstParagraphIdByFile.get(entry.file);
    if (!startParagraphId) continue;
    recovered.push({
      id: `${entry.id}::repeated-file`,
      title: entry.title,
      start_paragraph_id: startParagraphId,
      depth: entry.depth,
      order: entry.order,
      category: entry.category,
    });
  }

  return recovered;
}

function recoverTopLevelActCandidates(
  tocEntries: TocEntry[],
  firstParagraphIdByFile: Map<string, number>,
  bookTitle: string
): TocChapterCandidate[] {
  const actEntries = tocEntries.filter((entry) => {
    if (entry.category === "front" || entry.category === "back") return false;
    return classifyChapterKind(entry.title, bookTitle) === "act";
  });
  if (actEntries.length < 2) return [];

  const shallowestDepth = Math.min(...actEntries.map((entry) => entry.depth));
  return actEntries
    .filter((entry) => entry.depth === shallowestDepth)
    .map((entry) => {
      const startParagraphId = firstParagraphIdByFile.get(entry.file);
      if (!startParagraphId) return null;
      return {
        id: `${entry.id}::act-file`,
        title: entry.title,
        start_paragraph_id: startParagraphId,
        depth: entry.depth,
        order: entry.order,
        category: entry.category,
      };
    })
    .filter((entry): entry is TocChapterCandidate => entry !== null);
}

function isLikelyImplicitHeading(context: ParagraphContext, bookTitle: string, nextContext: ParagraphContext | null): boolean {
  const text = context.paragraph.text.trim();
  if (!text || !nextContext) return false;

  const kind = classifyChapterKind(text, bookTitle);
  if (kind === "front" || kind === "back") return false;

  if (kind === "chapter") {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    return wordCount <= 24 && text.length <= 180 && nextContext.paragraph.id === context.paragraph.id + 1;
  }

  return false;
}

function collectImplicitHeadingCandidates(
  paragraphContexts: ParagraphContext[],
  tocEntries: TocEntry[],
  bookTitle: string
): TocChapterCandidate[] {
  const tocEntriesByTitle = new Map<string, TocEntry[]>();
  for (const entry of tocEntries) {
    const normalized = normalizeForDedup(entry.title);
    const existing = tocEntriesByTitle.get(normalized) ?? [];
    existing.push(entry);
    tocEntriesByTitle.set(normalized, existing);
  }

  const candidates: TocChapterCandidate[] = [];
  for (let index = 0; index < paragraphContexts.length; index += 1) {
    const context = paragraphContexts[index]!;
    const nextContext = paragraphContexts[index + 1] ?? null;
    const matchingEntry = tocEntriesByTitle
      .get(context.normalized)
      ?.find((entry) => !isLikelyTopMatterTitle(entry.title, bookTitle) && !isReferenceStyleTitle(entry.title));
    const shouldInclude =
      isLikelyImplicitHeading(context, bookTitle, nextContext) ||
      (matchingEntry !== undefined &&
        context.file === matchingEntry.file &&
        context.paragraph.text.length <= matchingEntry.title.length + 40);
    if (!shouldInclude) continue;

    candidates.push({
      id: `implicit::${context.paragraph.id}`,
      title: matchingEntry?.title ?? context.paragraph.text,
      start_paragraph_id: context.paragraph.id,
      depth: matchingEntry?.depth ?? 1,
      order: matchingEntry?.order ?? Number.MAX_SAFE_INTEGER,
      category: matchingEntry?.category ?? "unknown",
    });
  }

  return candidates;
}

function preferLaterRepeatedNonPrimaryTitles(chapters: ParsedChapter[], bookTitle: string): ParsedChapter[] {
  const titleGroups = new Map<string, ParsedChapter[]>();
  for (const chapter of chapters) {
    const normalized = normalizeForDedup(chapter.title);
    const existing = titleGroups.get(normalized) ?? [];
    existing.push(chapter);
    titleGroups.set(normalized, existing);
  }

  const keepStarts = new Set<number>();
  for (const [normalizedTitle, group] of titleGroups) {
    const kind = classifyChapterKind(group[0]?.title ?? normalizedTitle, bookTitle);
    if (group.length === 1 || isPrimaryNarrativeKind(kind) || kind === "front" || kind === "back") {
      for (const chapter of group) keepStarts.add(chapter.start_paragraph_id);
      continue;
    }

    const latest = [...group].sort((a, b) => b.start_paragraph_id - a.start_paragraph_id)[0];
    if (latest) {
      keepStarts.add(latest.start_paragraph_id);
    }
  }

  return chapters.filter((chapter) => keepStarts.has(chapter.start_paragraph_id));
}

function finalizeChapters(chapters: ParsedChapter[], paragraphs: StoredParagraph[], bookTitle: string): ParsedChapter[] {
  const uniqueStarts = chooseBestPerStart(chapters, bookTitle);
  const withoutPrelude = dropPreludeBeforePrimaryChapters(uniqueStarts, bookTitle);
  const withoutWrappers = dropEarlyWrapperEntries(withoutPrelude, bookTitle);
  const withoutContainers = removeNearbyContainerEntries(withoutWrappers, bookTitle);
  const shifted = shiftChapterStartsPastHeadings(withoutContainers, paragraphs);
  const withoutSongs = removeSongCompanionEntries(shifted);
  const dedupedRepeats = preferLaterRepeatedNonPrimaryTitles(withoutSongs, bookTitle);
  const cleanedWrappers = dropEarlyWrapperEntries(dedupedRepeats, bookTitle);
  const finalized = chooseBestPerStart(cleanedWrappers, bookTitle).filter((chapter, index, list) => {
    if (index === 0) return true;
    return chapter.start_paragraph_id > list[index - 1]!.start_paragraph_id;
  });

  return finalized;
}

function selectPrimaryTocChapters(chapters: TocChapterCandidate[]): TocChapterCandidate[] {
  if (chapters.length <= 1) return chapters;

  const preferredPool = chapters.filter((chapter) => chapter.category !== "front" && chapter.category !== "back");
  const pool = preferredPool.length >= 2 ? preferredPool : chapters;
  const byDepth = new Map<number, TocChapterCandidate[]>();

  for (const chapter of pool) {
    const depthEntries = byDepth.get(chapter.depth) ?? [];
    depthEntries.push(chapter);
    byDepth.set(chapter.depth, depthEntries);
  }

  const stats = [...byDepth.entries()]
    .map(([depth, depthChapters]) => {
      const ordered = [...depthChapters].sort((a, b) => a.start_paragraph_id - b.start_paragraph_id);
      const gaps = ordered.slice(1).map((chapter, index) => chapter.start_paragraph_id - ordered[index]!.start_paragraph_id);
      return {
        depth,
        chapters: ordered,
        count: ordered.length,
        medianGap: median(gaps),
      };
    })
    .filter((entry) => entry.count >= 2);

  if (stats.length === 0) {
    return [...pool].sort((a, b) => a.start_paragraph_id - b.start_paragraph_id);
  }

  const bounded = stats.filter((entry) => entry.count <= 1000);
  const eligible = (bounded.length > 0 ? bounded : stats).filter((entry) => entry.medianGap >= 5);
  const ranked = (eligible.length > 0 ? eligible : bounded.length > 0 ? bounded : stats).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.medianGap !== a.medianGap) return b.medianGap - a.medianGap;
    return a.depth - b.depth;
  });

  return ranked[0]?.chapters ?? [...pool].sort((a, b) => a.start_paragraph_id - b.start_paragraph_id);
}

function recoverCollapsedChapters(
  chapters: ParsedChapter[],
  tocEntries: TocEntry[],
  paragraphContexts: ParagraphContext[],
  firstParagraphIdByFile: Map<string, number>,
  paragraphs: StoredParagraph[],
  bookTitle: string
): ParsedChapter[] {
  if (chapters.length !== 1 || tocEntries.length === 0 || paragraphContexts.length === 0) {
    return chapters;
  }

  const only = chapters[0]!;
  const onlyKind = classifyChapterKind(only.title, bookTitle);
  const normalizedOnlyTitle = normalizeForDedup(only.title);
  const normalizedBookTitle = normalizeForDedup(bookTitle);
  const shouldTryRecovery =
    tocEntries.length > 4 &&
    normalizedOnlyTitle !== normalizedBookTitle &&
    normalizedOnlyTitle !== "full book" &&
    (onlyKind === "front" || onlyKind === "back" || onlyKind === "other" || onlyKind === "numbered" || onlyKind === "scene");
  if (!shouldTryRecovery) {
    return chapters;
  }

  const topLevelActs = recoverTopLevelActCandidates(tocEntries, firstParagraphIdByFile, bookTitle);
  const repeatedTopLevel = recoverRepeatedTopLevelWorkCandidates(tocEntries, firstParagraphIdByFile, bookTitle);
  const recoveredToc = recoverCollapsedTocCandidates(tocEntries, paragraphContexts, bookTitle);
  const implicit = collectImplicitHeadingCandidates(paragraphContexts, tocEntries, bookTitle);
  const combinedById = new Map<string, TocChapterCandidate>();
  for (const candidate of [...topLevelActs, ...repeatedTopLevel, ...recoveredToc, ...implicit]) {
    combinedById.set(candidate.id, candidate);
  }

  let recovered = selectPrimaryTocChapters([...combinedById.values()]).map((candidate) => ({
    title: candidate.title,
    start_paragraph_id: candidate.start_paragraph_id,
  }));
  recovered = preferLaterRepeatedNonPrimaryTitles(recovered, bookTitle);
  recovered = finalizeChapters(recovered, paragraphs, bookTitle);

  if (recovered.length >= 2 && recovered.length > chapters.length) {
    return recovered;
  }

  return chapters;
}

function maybePreferImplicitPrimaryChapters(
  chapters: ParsedChapter[],
  tocChapterCandidates: TocChapterCandidate[],
  paragraphContexts: ParagraphContext[],
  paragraphs: StoredParagraph[],
  bookTitle: string
): ParsedChapter[] {
  const hasPrimary = chapters.some((chapter) => isPrimaryNarrativeKind(classifyChapterKind(chapter.title, bookTitle)));
  if (hasPrimary || chapters.length > 5) {
    return chapters;
  }

  const implicitPrimary = collectImplicitHeadingCandidates(paragraphContexts, [], bookTitle)
    .filter((candidate) => classifyChapterKind(candidate.title, bookTitle) === "chapter")
    .map((candidate) => ({
      title: candidate.title,
      start_paragraph_id: candidate.start_paragraph_id,
    }));

  if (implicitPrimary.length < 5) {
    return chapters;
  }

  const tocPrimary = tocChapterCandidates
    .filter((candidate) => classifyChapterKind(candidate.title, bookTitle) === "chapter")
    .map((candidate) => ({
      title: candidate.title,
      start_paragraph_id: candidate.start_paragraph_id,
    }));
  const recovered = finalizeChapters([...tocPrimary, ...implicitPrimary], paragraphs, bookTitle);
  return recovered.length >= 5 ? recovered : chapters;
}

export async function parseEpubBytes(bytes: Uint8Array, options?: ParseEpubOptions): Promise<ParsedEpubResult> {
  throwIfAborted(options?.signal);
  const zip = ZipArchive.fromBytes(bytes);

  if (zip.has("mimetype")) {
    throwIfAborted(options?.signal);
    const mimetype = (await zip.readEntryText("mimetype")).trim().toLowerCase();
    if (!mimetype.includes("application/epub+zip")) {
      throw new Error("Unsupported format: not an EPUB archive");
    }
  }

  throwIfAborted(options?.signal);
  await options?.onPhaseChange?.("extracting_metadata");
  const containerXml = await zip.readEntryText("META-INF/container.xml");
  const opfPath = parseContainerPath(containerXml);
  const opfXml = await zip.readEntryText(opfPath);
  const opf = parseOpf(opfXml, opfPath);

  const tocEntries: TocEntry[] = [];
  const structuralReferences = [...opf.guideReferences];
  let navTocEntries: TocEntry[] = [];
  let ncxTocEntries: TocEntry[] = [];

  if (opf.navPath && zip.has(opf.navPath)) {
    throwIfAborted(options?.signal);
    const navHtml = await zip.readEntryText(opf.navPath);
    const parsedNavigation = parseNavigationDocument(navHtml, opf.navPath);
    navTocEntries = parsedNavigation.tocEntries;
    structuralReferences.push(...parsedNavigation.landmarks);
  }
  if (opf.ncxPath && zip.has(opf.ncxPath)) {
    throwIfAborted(options?.signal);
    const ncxXml = await zip.readEntryText(opf.ncxPath);
    ncxTocEntries = parseTocFromNcx(ncxXml, opf.ncxPath);
  }
  tocEntries.push(...mergeTocEntries(navTocEntries, ncxTocEntries));

  const normalizedBookTitle = normalizeForDedup(opf.title);
  const referenceTypeIndex = buildReferenceTypeIndex(structuralReferences);
  for (const entry of tocEntries) {
    entry.category = classifyTocEntry(entry, referenceTypeIndex, normalizedBookTitle);
  }

  const {
    tocAnchorMapByFile,
    tocAnchorMapByUniqueFilename,
    tocFileMapByFile,
    tocFileMapByUniqueFilename,
  } = buildTocLookups(tocEntries);

  const normalizedTocTitles = new Set<string>(tocEntries.map((entry) => normalizeForDedup(entry.title)));
  const normalizedDuplicatedBookTitle = normalizeForDedup(`${opf.title}${opf.title}`);
  const paragraphs: StoredParagraph[] = [];
  const paragraphContexts: ParagraphContext[] = [];
  const images: ParsedEpubImage[] = [];
  const firstParagraphIdByFile = new Map<string, number>();
  const tocChapterCandidates: TocChapterCandidate[] = [];
  const seenTocEntries = new Set<string>();
  const seenFallbackChapters = new Set<string>();

  const addTocChapterCandidate = (entry: TocEntry, paragraphId: number) => {
    if (seenTocEntries.has(entry.id)) return;
    seenTocEntries.add(entry.id);
    tocChapterCandidates.push({
      id: entry.id,
      title: entry.title,
      start_paragraph_id: paragraphId,
      depth: entry.depth,
      order: entry.order,
      category: entry.category,
    });
  };

  const addFallbackChapter = (title: string, paragraphId: number) => {
    const fallbackKey = `${normalizeForDedup(title)}::${paragraphId}`;
    if (seenFallbackChapters.has(fallbackKey)) return;
    seenFallbackChapters.add(fallbackKey);
    tocChapterCandidates.push({
      id: fallbackKey,
      title,
      start_paragraph_id: paragraphId,
      depth: 1,
      order: Number.MAX_SAFE_INTEGER,
      category: "unknown",
    });
  };

  throwIfAborted(options?.signal);
  await options?.onPhaseChange?.("extracting_text");
  for (const [spineIndex, spinePath] of opf.spinePaths.entries()) {
    throwIfAborted(options?.signal);
    if (!zip.has(spinePath)) continue;

    const chapterHtml = await zip.readEntryText(spinePath);
    const extractedBlocks = extractBlocksFromChapter(chapterHtml);
    if (extractedBlocks.length === 0) continue;

    const normalizedEntryFile = normalizePath(spinePath);
    const entryFilename = getFilename(spinePath);
    const fileAnchorMap =
      tocAnchorMapByFile.get(normalizedEntryFile) ??
      tocAnchorMapByUniqueFilename.get(entryFilename) ??
      new Map<string, TocEntry[]>();

    const fileEntries =
      tocFileMapByFile.get(normalizedEntryFile) ??
      tocFileMapByUniqueFilename.get(entryFilename) ??
      [];

    let firstParagraphIdInFile: number | null = null;
    let pendingChapterEntries: TocEntry[] = [];
    let lastParagraphIdForImages = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]!.id : 0;

    for (const extracted of extractedBlocks) {
      throwIfAborted(options?.signal);

      if (extracted.kind === "image") {
        const rawSrc = extracted.src.trim();
        if (!rawSrc || /^https?:\/\//i.test(rawSrc)) continue;
        const resolvedSrc = rawSrc.toLowerCase().startsWith("data:image/")
          ? rawSrc
          : resolveRelativePath(spinePath, rawSrc);
        if (!resolvedSrc) continue;
        images.push({
          srcPath: resolvedSrc,
          alt: extracted.alt,
          afterParagraphId: lastParagraphIdForImages,
        });
        continue;
      }

      const normalizedParagraphText = normalizeForDedup(extracted.text);
      if (IGNORED_HEADINGS.has(normalizedParagraphText)) continue;

      const matchedEntries: TocEntry[] = [];
      for (const anchor of extracted.anchors) {
        const entries = fileAnchorMap.get(anchor.toLowerCase());
        if (entries) {
          for (const entry of entries) {
            matchedEntries.push(entry);
          }
        }
      }

      const isTocTitle = matchedEntries.some(
        (entry) => normalizeForDedup(entry.title) === normalizedParagraphText
      );
      const matchesAnyToc = normalizedTocTitles.has(normalizedParagraphText);
      const isBookTitle =
        normalizedParagraphText === normalizedBookTitle ||
        normalizedParagraphText === normalizedDuplicatedBookTitle;

      if (matchedEntries.length > 0 && (isTocTitle || matchesAnyToc)) {
        pendingChapterEntries = matchedEntries;
        continue;
      }
      if (isBookTitle) continue;

      const paragraphId = paragraphs.length + 1;
      paragraphs.push({
        id: paragraphId,
        text: extracted.text,
      });
      paragraphContexts.push({
        paragraph: paragraphs[paragraphs.length - 1]!,
        normalized: normalizedParagraphText,
        file: normalizedEntryFile,
        spineIndex,
      });
      lastParagraphIdForImages = paragraphId;
      if (firstParagraphIdInFile === null) {
        firstParagraphIdInFile = paragraphId;
        firstParagraphIdByFile.set(normalizedEntryFile, paragraphId);
      }

      if (pendingChapterEntries.length > 0) {
        for (const entry of pendingChapterEntries) {
          addTocChapterCandidate(entry, paragraphId);
        }
        pendingChapterEntries = [];
      }

      for (const entry of matchedEntries) {
        addTocChapterCandidate(entry, paragraphId);
      }
    }

    if (pendingChapterEntries.length > 0 && firstParagraphIdInFile !== null) {
      for (const entry of pendingChapterEntries) {
        addTocChapterCandidate(entry, firstParagraphIdInFile);
      }
    }

    if (fileEntries.length > 0 && firstParagraphIdInFile !== null) {
      for (const entry of fileEntries) {
        addTocChapterCandidate(entry, firstParagraphIdInFile);
      }
    }

    if (fileEntries.length === 0 && firstParagraphIdInFile !== null) {
      let chapterTitle: string | null = null;
      if (tocEntries.length === 0) {
        chapterTitle = extractHeadingFromChapter(loadHtml(chapterHtml)) ?? null;
      }
      if (chapterTitle) {
        addFallbackChapter(chapterTitle, firstParagraphIdInFile);
      }
    }
  }

  throwIfAborted(options?.signal);
  await options?.onPhaseChange?.("building_chapters");
  const expectedChapters = tocEntries.length;
  const foundEnough = tocChapterCandidates.length >= expectedChapters / 2 || expectedChapters <= 2;
  if (!foundEnough && paragraphs.length > 0) {
    const normalizedParagraphs = paragraphs.map((paragraph) => ({
      paragraph,
      normalized: normalizeForDedup(paragraph.text),
    }));

    for (const tocEntry of tocEntries) {
      if (seenTocEntries.has(tocEntry.id)) continue;
      const matchedParagraph = normalizedParagraphs.find(({ normalized }) =>
        matchesNormalizedTitle(normalized, normalizeForDedup(tocEntry.title))
      );
      if (!matchedParagraph) continue;
      addTocChapterCandidate(tocEntry, matchedParagraph.paragraph.id);
    }
  }

  tocChapterCandidates.sort((a, b) => {
    if (a.start_paragraph_id !== b.start_paragraph_id) {
      return a.start_paragraph_id - b.start_paragraph_id;
    }
    if (a.order !== b.order) return a.order - b.order;
    return a.depth - b.depth;
  });

  let chapters: ParsedChapter[] = tocEntries.length > 0
    ? selectPrimaryTocChapters(tocChapterCandidates).map((chapter) => ({
        title: chapter.title,
        start_paragraph_id: chapter.start_paragraph_id,
      }))
    : tocChapterCandidates.map((chapter) => ({
        title: chapter.title,
        start_paragraph_id: chapter.start_paragraph_id,
      }));

  if (chapters.length === 0 && paragraphs.length > 0) {
    chapters = [{ title: "Full book", start_paragraph_id: 1 }];
  }

  chapters = finalizeChapters(chapters, paragraphs, opf.title);
  chapters = recoverCollapsedChapters(
    chapters,
    tocEntries,
    paragraphContexts,
    firstParagraphIdByFile,
    paragraphs,
    opf.title
  );
  chapters = maybePreferImplicitPrimaryChapters(chapters, tocChapterCandidates, paragraphContexts, paragraphs, opf.title);
  if (chapters.length === 0 && paragraphs.length > 0) {
    chapters = [{
      title: opf.title || "Full book",
      start_paragraph_id: findFirstBodyParagraphStart(paragraphs, opf.title, opf.author),
    }];
  }
  chapters = normalizeSingleChapterOutput(chapters, paragraphs, opf.title, opf.author);

  const totalWords = paragraphs.reduce((sum, paragraph) => sum + tokenizeParagraph(paragraph.text).length, 0);

  return {
    title: opf.title,
    author: opf.author,
    language: opf.language,
    coverPath: opf.coverPath,
    paragraphs,
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      start_paragraph_id: chapter.start_paragraph_id,
    })),
    images,
    totalWords,
    tocEntries: tocEntries.length,
  };
}

export const __epubParserInternals = {
  parseContainerPath,
  parseOpf,
  parseNavigationDocument,
  parseTocFromNav,
  parseTocFromNcx,
  normalizePath,
  textMatchesTitle,
  extractParagraphsFromChapter,
  extractBlocksFromChapter,
  resolveRelativePath,
  classifyTocEntry,
  selectPrimaryTocChapters,
};

export type { ParseEpubOptions, ParsedChapter, ParsedEpubImage, ParsedEpubResult, ParsePhase };
