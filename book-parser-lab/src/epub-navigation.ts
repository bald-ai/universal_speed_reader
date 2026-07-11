import { load } from "cheerio";

import { normalizeText } from "./text.ts";
import { chaptersHaveCollapsedStarts } from "./model.ts";
import type { Chapter, ParserDiagnostic } from "./types.ts";
import {
  decodeMarkup,
  normalizeArchivePath,
  parseReference,
} from "./epub-archive.ts";
import {
  MAX_CONTENT_ENTRY_BYTES,
  elementsByLocalName,
  isSaneChapterTitle,
  loadDocument,
  localName,
  tokenSet,
  type ExtractionState,
} from "./epub-shared.ts";

const MAX_SHORT_SINGLE_DOCUMENT_WORDS = 10_000;

export function parseNavigationChapters(state: ExtractionState): Chapter[] {
  const navPath = state.packageData.navItem?.path
    ? state.archive.resolve(state.packageData.navItem.path)
    : null;
  if (navPath === null) return [];
  let markup: string;
  try {
    markup = decodeMarkup(state.archive.read(navPath, MAX_CONTENT_ENTRY_BYTES));
  } catch {
    return [];
  }
  const $ = loadDocument(markup, navPath);
  const navs = elementsByLocalName($, "nav").toArray();
  const tocNav =
    navs.find((element) => {
      const nav = $(element);
      const type = tokenSet(nav.attr("epub:type") ?? nav.attr("type"));
      return type.has("toc") || (nav.attr("role") ?? "").toLocaleLowerCase() === "doc-toc";
    }) ?? navs[0];
  if (!tocNav) return [];

  const result: Chapter[] = [];
  $(tocNav)
    .find("a[href]")
    .each((_index, element) => {
      const link = $(element);
      const href = link.attr("href");
      if (!href) return;
      // Preserve the complete label: illustrated editions often combine a caption
      // and chapter name in one TOC link, and that is the accepted golden behavior.
      const title = normalizeText(link.text()) || normalizeText(link.find("img[alt]").attr("alt") ?? "");
      const startParagraphId = resolveChapterTarget(navPath, href, state);
      if (startParagraphId !== null && isSaneChapterTitle(title)) {
        result.push({ title, startParagraphId });
      }
    });
  return result;
}

export function parseNcxChapters(state: ExtractionState): Chapter[] {
  const ncxPath = state.packageData.ncxItem?.path
    ? state.archive.resolve(state.packageData.ncxItem.path)
    : null;
  if (ncxPath === null) return [];
  let markup: string;
  try {
    markup = decodeMarkup(state.archive.read(ncxPath, MAX_CONTENT_ENTRY_BYTES));
  } catch {
    return [];
  }
  const $ = load(markup, { xml: true });
  const result: Chapter[] = [];
  elementsByLocalName($, "navpoint").each((_index, element) => {
    const point = $(element);
    const labelElement = point
      .children()
      .filter((_childIndex, child) => localName(child) === "navlabel")
      .first();
    const contentElement = point
      .children()
      .filter((_childIndex, child) => localName(child) === "content")
      .first();
    const title = normalizeText(labelElement.text());
    const href = contentElement.attr("src");
    if (!href) return;
    const startParagraphId = resolveChapterTarget(ncxPath, href, state);
    if (startParagraphId !== null && isSaneChapterTitle(title)) {
      result.push({ title, startParagraphId });
    }
  });
  return result;
}

function resolveChapterTarget(
  navigationPath: string,
  href: string,
  state: ExtractionState,
): number | null {
  const reference = parseReference(navigationPath, href);
  if (reference.path === null) return null;
  const targetPath = state.archive.resolve(reference.path) ?? normalizeArchivePath(reference.path);
  let paragraphId: number | undefined;
  if (reference.fragment) {
    paragraphId = state.anchors.get(anchorKey(targetPath, reference.fragment));
    if (paragraphId === undefined) {
      const lowerKey = anchorKey(targetPath, reference.fragment).toLocaleLowerCase();
      for (const [key, value] of state.anchors) {
        if (key.toLocaleLowerCase() === lowerKey) {
          paragraphId = value;
          break;
        }
      }
    }
  }
  paragraphId ??= state.fileStarts.get(targetPath);
  if (paragraphId === undefined) return null;
  return Math.max(1, Math.min(state.paragraphs.length, paragraphId));
}

export function chooseChapterSource(
  nav: Chapter[],
  ncx: Chapter[],
  headings: Chapter[],
  files: Chapter[],
  paragraphCount: number,
  wordCount: number,
  bookTitle: string,
  diagnostics: ParserDiagnostic[],
): Chapter[] {
  const cleanNav = cleanChapters(nav, paragraphCount);
  const cleanNcx = cleanChapters(ncx, paragraphCount);
  const cleanHeadings = cleanChapters(headings, paragraphCount);
  const navStarts = new Set(cleanNav.map((chapter) => chapter.startParagraphId)).size;
  const ncxStarts = new Set(cleanNcx.map((chapter) => chapter.startParagraphId)).size;
  const navCollapsed = chaptersHaveCollapsedStarts(cleanNav);
  const ncxCollapsed = chaptersHaveCollapsedStarts(cleanNcx);
  if (!navCollapsed && cleanNav.length > 0 && (
    ncxCollapsed || ncxStarts <= 1 || navStarts >= Math.ceil(ncxStarts / 2)
  )) {
    return cleanNav;
  }
  if (!ncxCollapsed && cleanNcx.length > 0 && (
    !navCollapsed || ncxStarts >= 2 || cleanHeadings.length === 0
  )) {
    return cleanNcx;
  }

  const collapsedNavigation = navCollapsed || ncxCollapsed;
  if (cleanHeadings.length > 0) {
    diagnostics.push({
      bucket: "Weak / missing / nonsense chapters",
      severity: "warning",
      message: collapsedNavigation
        ? "Navigation targets collapsed to too few positions; headings were used as chapters"
        : "Navigation TOC was unavailable; headings were used as chapters",
    });
    return cleanHeadings;
  }
  const cleanFiles = cleanChapters(files, paragraphCount);
  if (cleanFiles.length > 0) {
    const longSingleDocumentFallback =
      cleanFiles.length === 1 && wordCount >= MAX_SHORT_SINGLE_DOCUMENT_WORDS;
    diagnostics.push({
      bucket: "Weak / missing / nonsense chapters",
      severity: longSingleDocumentFallback ? "failure" : "warning",
      message: longSingleDocumentFallback
        ? `Long single-document EPUB (${wordCount} words) has no usable TOC or headings`
        : collapsedNavigation
          ? "Navigation targets collapsed and headings were unavailable; spine files were used as chapters"
          : "Navigation TOC and headings were unavailable; spine files were used as chapters",
    });
    return cleanFiles;
  }
  diagnostics.push({
    bucket: "Weak / missing / nonsense chapters",
    severity: "warning",
    message: "No chapter structure was found; a single book chapter was created",
  });
  return [{ title: bookTitle || "Start", startParagraphId: 1 }];
}

function cleanChapters(chapters: Chapter[], paragraphCount: number): Chapter[] {
  const result: Chapter[] = [];
  const seen = new Set<string>();
  for (const chapter of chapters) {
    const title = normalizeText(chapter.title);
    if (!isSaneChapterTitle(title)) continue;
    const startParagraphId = Math.max(1, Math.min(paragraphCount, chapter.startParagraphId));
    const key = `${title.toLocaleLowerCase()}\u0000${startParagraphId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ title, startParagraphId });
  }
  return result;
}

function anchorKey(path: string, fragment: string): string {
  return `${normalizeArchivePath(path)}#${fragment}`;
}
