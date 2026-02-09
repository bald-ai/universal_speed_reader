import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadHtml, type CheerioAPI } from "cheerio";
import EPub from "epub2";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOOK_ID = "test";
const EPUB_FILENAME = "test.epub";

type Paragraph = {
  id: number;
  text: string;
  chapterIndex: number;
};

type Chapter = {
  index: number;
  title: string;
  startParagraphId: number;
};

type BookJson = {
  id: string;
  title: string;
  author?: string;
  paragraphs: Paragraph[];
  chapters: Chapter[];
  totalWords: number;
};

type TocEntry = {
  title: string;
  file: string;
  anchor?: string;
  order: number;
};

// Titles to ignore (common EPUB structural elements)
const IGNORED_HEADINGS = new Set([
  "document outline",
  "table of contents",
  "contents",
  "toc",
  "índice",
  "indice",
  "tabla de contenidos",
  "copyright",
  "title page",
  "cover",
  "portada",
]);

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^["']+|["']+$/g, ""))
    .filter((word) => word.length > 0);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function getChapterRawAsync(epub: EPub, chapterId: string): Promise<string | null> {
  return new Promise((resolve) => {
    epub.getChapterRaw(chapterId, (err, text) => {
      if (err || !text) resolve(null);
      else resolve(text);
    });
  });
}

/**
 * Normalize file paths for consistent matching.
 */
function normalizePath(href: string | undefined): string {
  if (!href) return "";
  return href
    .replace(/^\.\//, "")
    .replace(/^(\.\.\/)+/g, "")
    .replace(/^OEBPS\//i, "")
    .replace(/^OPS\//i, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * Extract just the filename from a path for fallback matching.
 */
function getFilename(href: string | undefined): string {
  if (!href) return "";
  const normalized = normalizePath(href);
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

/**
 * Normalize text for deduplication and matching.
 */
function normalizeForDedup(value: string): string {
  // Remove diacritics by normalizing and removing combining marks
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Collect all anchor IDs from an element and its children/parents.
 */
function collectAnchors(
  $: CheerioAPI,
  element: any,
  seenIds: Set<string>
): string[] {
  const el = $(element);
  const anchors: string[] = [];

  const addAnchor = (id: string | undefined) => {
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      anchors.push(id);
    }
  };

  // Check the element itself
  addAnchor(el.attr("id"));

  // Check all descendants with id or name attributes
  el.find("[id], [name]").each((_, child) => {
    addAnchor($(child).attr("id"));
    addAnchor($(child).attr("name"));
  });

  // Check immediate parent (anchor might be on wrapper div)
  const parent = el.parent();
  if (parent.length) {
    addAnchor(parent.attr("id"));
  }

  // Check preceding siblings that are empty anchors
  let prev = el.prev();
  while (prev.length && prev.text().trim() === "") {
    addAnchor(prev.attr("id"));
    addAnchor(prev.attr("name"));
    prev = prev.prev();
  }

  return anchors;
}

/**
 * Extract heading from chapter HTML.
 */
function extractHeadingFromChapter($: CheerioAPI): string | null {
  const headingSelectors = "h1, h2, h3, h4, header h1, header h2, .chapter-title, .title";

  const candidate = $(headingSelectors)
    .map((_, el) => $(el).text())
    .get()
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find((text) => {
      if (text.length === 0) return false;
      const normalized = text.toLowerCase();
      return !IGNORED_HEADINGS.has(normalized);
    });

  return candidate && candidate.length > 0 ? candidate : null;
}

/**
 * Extract paragraphs from chapter HTML.
 */
function extractParagraphsFromChapter(html: string): { text: string; anchors: string[] }[] {
  const $ = loadHtml(html, {
    xmlMode: false,
  });

  const cleaned: { text: string; anchors: string[] }[] = [];
  const seenIds = new Set<string>();

  // Process content elements (not just <p> tags)
  $("p, div, li, h1, h2, h3, h4, h5, h6").each((_, element) => {
    const el = $(element);
    const text = el.text();
    const normalized = text.replace(/\s+/g, " ").trim();

    if (normalized.length < 2) return;

    // Skip if this is a nested element (avoid duplicates)
    if (el.find("p, div, li").length > 0 && el.is("div")) {
      return;
    }

    const anchors = collectAnchors($, element, seenIds);
    cleaned.push({ text: normalized, anchors });
  });

  // Fallback: if no paragraphs found, get root text
  if (cleaned.length === 0) {
    const rootText = $.root().text().replace(/\s+/g, " ").trim();
    if (rootText.length >= 2) {
      cleaned.push({ text: rootText, anchors: [] });
    }
  }

  return cleaned;
}

/**
 * Check if paragraph text matches a TOC title.
 */
function textMatchesTitle(paraText: string, tocTitle: string): boolean {
  const normalizedPara = normalizeForDedup(paraText);
  const normalizedTitle = normalizeForDedup(tocTitle);

  // Exact match
  if (normalizedPara === normalizedTitle) return true;

  // Paragraph starts with title
  if (normalizedPara.startsWith(normalizedTitle + " ")) return true;

  // Title with punctuation
  if (
    normalizedPara === normalizedTitle + "." ||
    normalizedPara === normalizedTitle + ","
  )
    return true;

  // Short paragraph contains title (chapter headings)
  if (
    normalizedPara.length < normalizedTitle.length + 15 &&
    normalizedPara.includes(normalizedTitle)
  ) {
    return true;
  }

  // Handle numbered chapters: "Chapter 1" matches "1. Chapter Title"
  const chapterNumMatch = normalizedTitle.match(/^(\d+)\.\s*(.+)$/);
  if (chapterNumMatch) {
    const [, num, rest] = chapterNumMatch;
    if (
      normalizedPara === num ||
      normalizedPara === `chapter ${num}` ||
      normalizedPara === `capitulo ${num}` ||
      normalizedPara === rest
    ) {
      return true;
    }
  }

  return false;
}

async function processEpub() {
  const projectRoot = path.resolve(__dirname, "..");
  const epubPath = path.join(projectRoot, EPUB_FILENAME);
  const outputDir = path.join(projectRoot, "public", "books");
  const outputPath = path.join(outputDir, `${BOOK_ID}.json`);

  await ensureDir(outputDir);

  const epub = await EPub.createAsync(epubPath, "/images/", "/chapters/");

  const title = (epub.metadata && epub.metadata.title) || "Pride and Prejudice";
  const author = (epub.metadata && epub.metadata.creator) || "Jane Austen";

  const paragraphs: Paragraph[] = [];
  const chapters: Chapter[] = [];
  const seenChapterTitles = new Set<string>();

  // STEP 1: Build TOC lookup structures
  const tocEntries: TocEntry[] = [];
  const tocIdMap = new Map<string, string>();
  const tocAnchorMap = new Map<string, Map<string, string>>();
  const tocFileMap = new Map<string, string>();

  for (let i = 0; i < (epub.toc ?? []).length; i++) {
    const tocEntry = epub.toc![i];
    if (!tocEntry?.title) continue;

    const trimmedTitle = String(tocEntry.title).replace(/\s+/g, " ").trim();
    if (trimmedTitle.length === 0) continue;

    if (tocEntry.id) {
      tocIdMap.set(tocEntry.id, trimmedTitle);
    }

    if (tocEntry.href) {
      const [rawFile, anchor] = tocEntry.href.split("#");
      const normalizedFile = normalizePath(rawFile);
      const filename = getFilename(rawFile);

      tocEntries.push({
        title: trimmedTitle,
        file: normalizedFile,
        anchor,
        order: i,
      });

      if (anchor) {
        for (const key of [normalizedFile, filename]) {
          if (!tocAnchorMap.has(key)) {
            tocAnchorMap.set(key, new Map());
          }
          tocAnchorMap.get(key)!.set(anchor, trimmedTitle);
        }
      } else {
        tocFileMap.set(normalizedFile, trimmedTitle);
        tocFileMap.set(filename, trimmedTitle);
      }
    }
  }

  // STEP 2: Process flow entries
  let paragraphCount = 0;
  const collectedParagraphs: Paragraph[] = [];

  for (let flowIndex = 0; flowIndex < epub.flow.length; flowIndex += 1) {
    const flowItem = epub.flow[flowIndex];
    if (!flowItem?.id) continue;

    const rawHtml = await getChapterRawAsync(epub, flowItem.id);
    if (!rawHtml) continue;

    const chapterContent = extractParagraphsFromChapter(rawHtml);
    if (chapterContent.length === 0) continue;

    const normalizedEntryFile = normalizePath(flowItem.href);
    const entryFilename = getFilename(flowItem.href);

    const fileAnchorMap =
      tocAnchorMap.get(normalizedEntryFile) ||
      tocAnchorMap.get(entryFilename) ||
      new Map<string, string>();

    const fileChapters: { paragraphId: number; title: string }[] = [];
    const startParagraphIdForFile = paragraphCount;

    for (const para of chapterContent) {
      const normalizedParaText = normalizeForDedup(para.text);

      // Skip structural headings (title page, TOC, etc.)
      if (IGNORED_HEADINGS.has(normalizedParaText)) continue;

      // Check if any anchor matches TOC (before creating the paragraph)
      let matchedTocTitle: string | null = null;
      for (const anchor of para.anchors) {
        const tocTitle = fileAnchorMap.get(anchor);
        if (tocTitle) {
          matchedTocTitle = tocTitle;
          break;
        }
      }

      // Skip paragraphs that are just a chapter/TOC title repeated as body text
      const isTocTitle =
        matchedTocTitle && normalizeForDedup(matchedTocTitle) === normalizedParaText;
      const matchesAnyTocEntry = tocEntries.some(
        (e) => normalizeForDedup(e.title) === normalizedParaText
      );
      const isBookTitle =
        normalizedParaText === normalizeForDedup(title) ||
        normalizedParaText === normalizeForDedup(`${title}${title}`);
      if (isTocTitle || matchesAnyTocEntry || isBookTitle) continue;

      paragraphCount += 1;
      const paragraph: Paragraph = {
        id: paragraphCount,
        text: para.text,
        chapterIndex: flowIndex,
      };

      if (matchedTocTitle) {
        const normalizedKey = normalizeForDedup(matchedTocTitle);
        if (!seenChapterTitles.has(normalizedKey)) {
          seenChapterTitles.add(normalizedKey);
          fileChapters.push({ paragraphId: paragraphCount, title: matchedTocTitle });
        }
      }

      paragraphs.push(paragraph);
      collectedParagraphs.push(paragraph);
    }

    // Add chapters found via anchors
    for (const ch of fileChapters) {
      chapters.push({
        index: chapters.length,
        title: ch.title,
        startParagraphId: ch.paragraphId,
      });
    }

    // If no anchor-based chapters, try other methods
    if (fileChapters.length === 0) {
      let chapterTitle = tocIdMap.get(flowItem.id);

      if (!chapterTitle) {
        chapterTitle =
          tocFileMap.get(normalizedEntryFile) ||
          tocFileMap.get(entryFilename);
      }

      if (!chapterTitle) {
        const $ = loadHtml(rawHtml);
        chapterTitle = extractHeadingFromChapter($) ?? undefined;
      }

      if (chapterTitle) {
        const normalizedKey = normalizeForDedup(chapterTitle);
        if (!seenChapterTitles.has(normalizedKey)) {
          seenChapterTitles.add(normalizedKey);
          chapters.push({
            index: chapters.length,
            title: chapterTitle,
            startParagraphId: startParagraphIdForFile,
          });
        }
      }
    }
  }

  // STEP 3: Fallback - Text matching if not enough chapters found
  const expectedChapters = tocEntries.length;
  const foundEnough = chapters.length >= expectedChapters / 2 || expectedChapters <= 2;

  if (!foundEnough && collectedParagraphs.length > 0) {
    chapters.length = 0;
    seenChapterTitles.clear();

    for (const tocEntry of tocEntries) {
      const normalizedTocTitle = normalizeForDedup(tocEntry.title);

      for (const para of collectedParagraphs) {
        if (textMatchesTitle(para.text, tocEntry.title)) {
          if (!seenChapterTitles.has(normalizedTocTitle)) {
            seenChapterTitles.add(normalizedTocTitle);
            chapters.push({
              index: chapters.length,
              title: tocEntry.title,
              startParagraphId: para.id,
            });
          }
          break;
        }
      }
    }

    chapters.sort((a, b) => a.startParagraphId - b.startParagraphId);
  }

  // STEP 4: Final fallback - create default chapter
  if (chapters.length === 0 && paragraphCount > 0) {
    chapters.push({
      index: 0,
      title: "Full book",
      startParagraphId: 1,
    });
  }

  // Re-index chapters
  chapters.forEach((ch, i) => {
    ch.index = i;
  });

  const totalWords = paragraphs.reduce((sum, paragraph) => sum + tokenize(paragraph.text).length, 0);

  const bookJson: BookJson = {
    id: BOOK_ID,
    title,
    author,
    paragraphs,
    chapters,
    totalWords
  };

  await fs.writeFile(outputPath, JSON.stringify(bookJson), "utf8");
  // eslint-disable-next-line no-console
  console.log(`Processed EPUB → ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(`Found ${chapters.length} chapters from ${tocEntries.length} TOC entries`);
}

processEpub().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to process EPUB:", error);
  process.exit(1);
});
