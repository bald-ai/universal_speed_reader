import { load as loadHtml, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { ProcessingStatus, StoredParagraph } from "@/types/storage";
import { ZipArchive } from "@/lib/epub/zipArchive";

type TocEntry = {
  title: string;
  file: string;
  anchor?: string;
  order: number;
};

type ParsePhase = Extract<ProcessingStatus, "extracting_metadata" | "extracting_text" | "building_chapters">;

export type ParsedChapter = {
  title: string;
  start_paragraph_id: number;
};

export type ParsedEpubResult = {
  title: string;
  author: string | null;
  language: string | null;
  coverPath: string | null;
  paragraphs: StoredParagraph[];
  chapters: ParsedChapter[];
  totalWords: number;
  tocEntries: number;
};

export type ParseEpubOptions = {
  onPhaseChange?: (phase: ParsePhase) => void | Promise<void>;
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
};

type ExtractedParagraph = {
  text: string;
  anchors: string[];
};

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

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^["']+|["']+$/g, ""))
    .filter((word) => word.length > 0);
}

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

function textMatchesTitle(paraText: string, tocTitle: string): boolean {
  const normalizedPara = normalizeForDedup(paraText);
  const normalizedTitle = normalizeForDedup(tocTitle);

  if (normalizedPara === normalizedTitle) return true;
  if (normalizedPara.startsWith(`${normalizedTitle} `)) return true;
  if (normalizedPara === `${normalizedTitle}.` || normalizedPara === `${normalizedTitle},`) return true;

  if (
    normalizedPara.length < normalizedTitle.length + 15 &&
    normalizedPara.includes(normalizedTitle)
  ) {
    return true;
  }

  const chapterNumMatch = normalizedTitle.match(/^(\d+)\.\s*(.+)$/);
  if (chapterNumMatch) {
    const [, num, rest] = chapterNumMatch;
    if (
      normalizedPara === num ||
      normalizedPara === `chapter ${num}` ||
      normalizedPara === rest
    ) {
      return true;
    }
  }

  return false;
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
  const manifestByPath = new Map<string, ManifestItem>();

  $("manifest item").each((_, node) => {
    const id = $(node).attr("id");
    const href = $(node).attr("href");
    if (!id || !href) return;
    const mediaType = $(node).attr("media-type") ?? "";
    const properties = $(node).attr("properties") ?? "";
    const resolvedPath = resolveRelativePath(opfPath, href);
    const item: ManifestItem = { id, href, mediaType, properties, resolvedPath };
    manifestById.set(id, item);
    manifestByPath.set(normalizePath(resolvedPath), item);
  });

  const spinePaths: string[] = [];
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
    const coverItem = [...manifestById.values()].find((item) =>
      item.mediaType.startsWith("image/")
    );
    coverPath = coverItem?.resolvedPath ?? null;
  }

  if (spinePaths.length === 0) {
    throw new Error("Corrupted/Unreadable EPUB: OPF spine is empty");
  }

  return {
    title,
    author,
    language,
    coverPath,
    spinePaths,
    navPath: navItem?.resolvedPath ?? null,
    ncxPath: ncxItem?.resolvedPath ?? null,
  };
}

function parseTocFromNav(navHtml: string, navPath: string): TocEntry[] {
  const $ = loadHtml(navHtml);
  const rootNav = $('nav[epub\\:type="toc"], nav[type="toc"]').first();
  const root = rootNav.length > 0 ? rootNav : $("body");
  const tocEntries: TocEntry[] = [];

  root.find("a[href]").each((index, node) => {
    const href = $(node).attr("href");
    if (!href) return;
    const text = $(node).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    const [filePart, anchorPart] = href.split("#");
    const resolvedFile = filePart
      ? resolveRelativePath(navPath, filePart)
      : normalizePathSegments(navPath);
    tocEntries.push({
      title: text,
      file: normalizePath(resolvedFile),
      anchor: anchorPart || undefined,
      order: index,
    });
  });

  return tocEntries;
}

function parseTocFromNcx(ncxXml: string, ncxPath: string): TocEntry[] {
  const $ = loadHtml(ncxXml, { xmlMode: true });
  const tocEntries: TocEntry[] = [];

  $("navMap navPoint").each((index, node) => {
    const title = $(node).find("navLabel text").first().text().replace(/\s+/g, " ").trim();
    const src = $(node).find("content").first().attr("src");
    if (!title || !src) return;
    const [filePart, anchorPart] = src.split("#");
    const resolvedFile = resolveRelativePath(ncxPath, filePart);
    tocEntries.push({
      title,
      file: normalizePath(resolvedFile),
      anchor: anchorPart || undefined,
      order: index,
    });
  });

  return tocEntries;
}

function collectAnchors($: CheerioAPI, node: AnyNode, seenIds: Set<string>): string[] {
  const element = $(node);
  const anchors: string[] = [];

  const addAnchor = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (seenIds.has(trimmed)) return;
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

  let previous = element.prev();
  while (previous.length > 0 && previous.text().trim() === "") {
    addAnchor(previous.attr("id"));
    addAnchor(previous.attr("name"));
    previous = previous.prev();
  }

  return anchors;
}

function extractHeadingFromChapter($: CheerioAPI): string | null {
  const headingSelectors = "h1, h2, h3, h4, header h1, header h2, .chapter-title, .title";
  const candidate = $(headingSelectors)
    .map((_, node) => $(node).text())
    .get()
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find((text) => text.length > 0 && !IGNORED_HEADINGS.has(text.toLowerCase()));
  return candidate ?? null;
}

function extractParagraphsFromChapter(html: string): ExtractedParagraph[] {
  const $ = loadHtml(html, { xmlMode: false });
  $("script, style, noscript, svg, title").remove();
  const cleaned: ExtractedParagraph[] = [];
  const seenIds = new Set<string>();

  $("p, div, li, h1, h2, h3, h4, h5, h6").each((_, node) => {
    const element = $(node);
    const normalized = element.text().replace(/\s+/g, " ").trim();
    if (normalized.length < 2) return;
    if (normalized.includes("{") && normalized.includes("}")) return;
    if (element.find("p, div, li").length > 0 && element.is("div")) return;
    const anchors = collectAnchors($, node, seenIds);
    cleaned.push({ text: normalized, anchors });
  });

  if (cleaned.length === 0) {
    const rootText = $.root().text().replace(/\s+/g, " ").trim();
    if (rootText.length >= 2) {
      cleaned.push({ text: rootText, anchors: [] });
    }
  }

  return cleaned;
}

function buildTocLookups(tocEntries: TocEntry[]) {
  const tocAnchorMap = new Map<string, Map<string, string>>();
  const tocFileMap = new Map<string, string>();

  for (const tocEntry of tocEntries) {
    const normalizedFile = normalizePath(tocEntry.file);
    const filename = getFilename(tocEntry.file);
    if (tocEntry.anchor) {
      const normalizedAnchor = tocEntry.anchor.toLowerCase();
      for (const key of [normalizedFile, filename]) {
        if (!tocAnchorMap.has(key)) {
          tocAnchorMap.set(key, new Map<string, string>());
        }
        tocAnchorMap.get(key)?.set(normalizedAnchor, tocEntry.title);
      }
    } else {
      tocFileMap.set(normalizedFile, tocEntry.title);
      tocFileMap.set(filename, tocEntry.title);
    }
  }

  return { tocAnchorMap, tocFileMap };
}

export async function parseEpubBytes(bytes: Uint8Array, options?: ParseEpubOptions): Promise<ParsedEpubResult> {
  const zipBytes = new Uint8Array(bytes);
  const zip = ZipArchive.fromArrayBuffer(zipBytes.buffer as ArrayBuffer);

  if (zip.has("mimetype")) {
    const mimetype = (await zip.readEntryText("mimetype")).trim().toLowerCase();
    if (!mimetype.includes("application/epub+zip")) {
      throw new Error("Unsupported format: not an EPUB archive");
    }
  }

  await options?.onPhaseChange?.("extracting_metadata");
  const containerXml = await zip.readEntryText("META-INF/container.xml");
  const opfPath = parseContainerPath(containerXml);
  const opfXml = await zip.readEntryText(opfPath);
  const opf = parseOpf(opfXml, opfPath);

  const tocEntries: TocEntry[] = [];
  if (opf.navPath && zip.has(opf.navPath)) {
    const navHtml = await zip.readEntryText(opf.navPath);
    tocEntries.push(...parseTocFromNav(navHtml, opf.navPath));
  }
  if (tocEntries.length === 0 && opf.ncxPath && zip.has(opf.ncxPath)) {
    const ncxXml = await zip.readEntryText(opf.ncxPath);
    tocEntries.push(...parseTocFromNcx(ncxXml, opf.ncxPath));
  }

  const { tocAnchorMap, tocFileMap } = buildTocLookups(tocEntries);
  const paragraphs: StoredParagraph[] = [];
  const chapters: ParsedChapter[] = [];
  const seenChapterTitles = new Set<string>();

  await options?.onPhaseChange?.("extracting_text");
  for (const spinePath of opf.spinePaths) {
    if (!zip.has(spinePath)) continue;
    const chapterHtml = await zip.readEntryText(spinePath);
    const extractedParagraphs = extractParagraphsFromChapter(chapterHtml);
    if (extractedParagraphs.length === 0) continue;

    const normalizedEntryFile = normalizePath(spinePath);
    const entryFilename = getFilename(spinePath);
    const fileAnchorMap =
      tocAnchorMap.get(normalizedEntryFile) ?? tocAnchorMap.get(entryFilename) ?? new Map<string, string>();

    const fileChapters: ParsedChapter[] = [];
    let firstParagraphIdInFile: number | null = null;

    for (const extracted of extractedParagraphs) {
      const normalizedParagraphText = normalizeForDedup(extracted.text);
      if (IGNORED_HEADINGS.has(normalizedParagraphText)) continue;

      let matchedTocTitle: string | null = null;
      for (const anchor of extracted.anchors) {
        const title = fileAnchorMap.get(anchor.toLowerCase());
        if (title) {
          matchedTocTitle = title;
          break;
        }
      }

      const isTocTitle =
        matchedTocTitle && normalizeForDedup(matchedTocTitle) === normalizedParagraphText;
      const matchesAnyToc = tocEntries.some(
        (entry) => normalizeForDedup(entry.title) === normalizedParagraphText
      );
      const isBookTitle =
        normalizedParagraphText === normalizeForDedup(opf.title) ||
        normalizedParagraphText === normalizeForDedup(`${opf.title}${opf.title}`);

      if (isTocTitle || matchesAnyToc || isBookTitle) continue;

      const paragraphId = paragraphs.length + 1;
      paragraphs.push({
        id: paragraphId,
        text: extracted.text,
      });
      if (firstParagraphIdInFile === null) {
        firstParagraphIdInFile = paragraphId;
      }

      if (matchedTocTitle) {
        const chapterKey = normalizeForDedup(matchedTocTitle);
        if (!seenChapterTitles.has(chapterKey)) {
          seenChapterTitles.add(chapterKey);
          fileChapters.push({
            title: matchedTocTitle,
            start_paragraph_id: paragraphId,
          });
        }
      }
    }

    for (const chapter of fileChapters) {
      chapters.push(chapter);
    }

    if (fileChapters.length === 0 && firstParagraphIdInFile !== null) {
      let chapterTitle = tocFileMap.get(normalizedEntryFile) ?? tocFileMap.get(entryFilename) ?? null;
      // When TOC exists, keep chapter labels TOC-driven and avoid heading-based guesses.
      if (!chapterTitle && tocEntries.length === 0) {
        chapterTitle = extractHeadingFromChapter(loadHtml(chapterHtml)) ?? null;
      }
      if (chapterTitle) {
        const chapterKey = normalizeForDedup(chapterTitle);
        if (!seenChapterTitles.has(chapterKey)) {
          seenChapterTitles.add(chapterKey);
          chapters.push({
            title: chapterTitle,
            start_paragraph_id: firstParagraphIdInFile,
          });
        }
      }
    }
  }

  await options?.onPhaseChange?.("building_chapters");
  const expectedChapters = tocEntries.length;
  const foundEnough = chapters.length >= expectedChapters / 2 || expectedChapters <= 2;
  if (!foundEnough && paragraphs.length > 0) {
    chapters.length = 0;
    seenChapterTitles.clear();

    for (const tocEntry of tocEntries) {
      const chapterKey = normalizeForDedup(tocEntry.title);
      if (seenChapterTitles.has(chapterKey)) continue;

      const matchedParagraph = paragraphs.find((paragraph) =>
        textMatchesTitle(paragraph.text, tocEntry.title)
      );
      if (!matchedParagraph) continue;
      seenChapterTitles.add(chapterKey);
      chapters.push({
        title: tocEntry.title,
        start_paragraph_id: matchedParagraph.id,
      });
    }
    chapters.sort((a, b) => a.start_paragraph_id - b.start_paragraph_id);
  }

  if (chapters.length === 0 && paragraphs.length > 0) {
    chapters.push({
      title: "Full book",
      start_paragraph_id: 1,
    });
  }

  const totalWords = paragraphs.reduce((sum, paragraph) => sum + tokenize(paragraph.text).length, 0);
  const normalizedChapters = chapters.map((chapter) => ({
    title: chapter.title,
    start_paragraph_id: chapter.start_paragraph_id,
  }));

  return {
    title: opf.title,
    author: opf.author,
    language: opf.language,
    coverPath: opf.coverPath,
    paragraphs,
    chapters: normalizedChapters,
    totalWords,
    tocEntries: tocEntries.length,
  };
}

export const __epubParserInternals = {
  parseContainerPath,
  parseOpf,
  parseTocFromNav,
  parseTocFromNcx,
  normalizePath,
  textMatchesTitle,
  extractParagraphsFromChapter,
  resolveRelativePath,
};
