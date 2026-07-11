import { buildBook } from "./model.ts";
import { measureTextViability } from "./text.ts";
import type { ParseOptions, ParserDiagnostic, ParserOutput } from "./types.ts";
import {
  SelectiveZipArchive,
  checkDeadline,
  decodeMarkup,
} from "./epub-archive.ts";
import {
  createExtractionState,
  discoverCover,
  extractContentDocument,
} from "./epub-content.ts";
import {
  chooseChapterSource,
  parseNavigationChapters,
  parseNcxChapters,
} from "./epub-navigation.ts";
import {
  inspectMimetype,
  isContentDocument,
  parseContainer,
  parsePackageDocument,
  preloadContentDocuments,
  resolveManifestPath,
} from "./epub-package.ts";
import {
  DEFAULT_TIMEOUT_MS,
  EpubParseError,
  MAX_CONTENT_ENTRY_BYTES,
  MAX_STRUCTURE_ENTRY_BYTES,
} from "./epub-shared.ts";

export { EpubParseError } from "./epub-shared.ts";

/** Parse a reflowable EPUB into the app's paragraph/chapter/image model. */
export async function parseEpub(options: ParseOptions): Promise<ParserOutput> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EpubParseError("Other", "EPUB timeout must be a positive number");
  }
  const deadline = startedAt + timeoutMs;

  if (options.signal?.aborted) {
    throw new EpubParseError("Timeout / extreme slowness", "EPUB import was cancelled");
  }
  const sourceBytes = options.sourceBytes;
  await options.onPhaseChange?.("extracting_metadata");
  checkDeadline(deadline, timeoutMs);

  let archive: SelectiveZipArchive;
  try {
    archive = new SelectiveZipArchive(sourceBytes);
  } catch (error) {
    throw new EpubParseError("Crash", "EPUB is not a readable ZIP archive", {
      cause: error,
    });
  }
  const openMs = performance.now() - startedAt;
  const diagnostics: ParserDiagnostic[] = [];

  inspectMimetype(archive, diagnostics);
  const containerPath = archive.resolve("META-INF/container.xml");
  if (containerPath === null) {
    throw new EpubParseError("Crash", "EPUB container.xml is missing");
  }
  const opfReference = parseContainer(
    decodeMarkup(archive.read(containerPath, MAX_STRUCTURE_ENTRY_BYTES)),
  );
  const opfPath = archive.resolve(opfReference);
  if (opfPath === null) {
    throw new EpubParseError(
      "Crash",
      `EPUB package document is missing: ${opfReference}`,
    );
  }
  const packageData = parsePackageDocument(
    decodeMarkup(archive.read(opfPath, MAX_STRUCTURE_ENTRY_BYTES)),
    opfPath,
    options.sourceName,
    archive,
    diagnostics,
  );
  checkDeadline(deadline, timeoutMs);
  const structureMs = performance.now() - startedAt - openMs;

  preloadContentDocuments(archive, packageData);
  let state = createExtractionState(
    archive,
    packageData,
    diagnostics,
    deadline,
    timeoutMs,
  );
  state.cover = await discoverCover(state);
  if (state.cover === null) {
    diagnostics.push({
      bucket: "Cover missing",
      severity: "warning",
      message: "No declared or credible fallback cover was found",
    });
  }

  const hasLinearContent = packageData.spine.some((spineItem) => {
    const path = resolveManifestPath(archive, spineItem.item);
    return (
      spineItem.linear &&
      packageData.navItem !== spineItem.item &&
      path !== null &&
      isContentDocument(spineItem.item, path)
    );
  });
  // Non-linear spine resources are auxiliary by EPUB semantics. Use them only
  // when the publication supplies no linear content reading order at all.
  const readingOrder = hasLinearContent
    ? packageData.spine.filter((spineItem) => spineItem.linear)
    : packageData.spine;
  const extractReadingOrder = async (
    items: typeof packageData.spine,
    targetState: ReturnType<typeof createExtractionState>,
  ): Promise<number> => {
    let extractedDocuments = 0;
    for (const [index, spineItem] of items.entries()) {
      checkDeadline(deadline, timeoutMs);
      const documentPath = resolveManifestPath(archive, spineItem.item);
      if (documentPath === null) {
        targetState.diagnostics.push({
          bucket: "Other",
          severity: "failure",
          message: `Spine resource is missing: ${spineItem.item.href}`,
          details: { idref: spineItem.idref },
        });
        continue;
      }
      if (!isContentDocument(spineItem.item, documentPath)) {
        targetState.diagnostics.push({
          bucket: "Other",
          severity: "failure",
          message: `Unsupported spine media type: ${spineItem.item.mediaType || "unknown"}`,
          details: { path: documentPath },
        });
        continue;
      }
      // A navigation document in the spine duplicates link labels as book text.
      if (packageData.navItem === spineItem.item) continue;

      await extractContentDocument(
        decodeMarkup(archive.read(documentPath, MAX_CONTENT_ENTRY_BYTES)),
        documentPath,
        spineItem.item.mediaType,
        index,
        targetState,
      );
      extractedDocuments += 1;
    }
    return extractedDocuments;
  };

  const contentDiagnosticStart = diagnostics.length;
  await options.onPhaseChange?.("extracting_text");
  let sourceDocumentCount = await extractReadingOrder(readingOrder, state);
  const linearTextViability = measureTextViability(
    state.paragraphs.map((paragraph) => paragraph.text).join(" "),
  );
  if (
    hasLinearContent &&
    !linearTextViability.usable &&
    packageData.spine.some((spineItem) => !spineItem.linear)
  ) {
    // Some malformed publications mark the only useful text non-linear while
    // leaving a cover/title wrapper linear. Evaluate the full spine separately:
    // a genuinely short linear story must not absorb auxiliary content that
    // still cannot make the book viable.
    const recoveryDiagnostics = diagnostics.slice(0, contentDiagnosticStart);
    const recoveryState = createExtractionState(
      archive,
      packageData,
      recoveryDiagnostics,
      deadline,
      timeoutMs,
    );
    recoveryState.cover = state.cover;
    const recoveryDocumentCount = await extractReadingOrder(packageData.spine, recoveryState);
    const recoveryViability = measureTextViability(
      recoveryState.paragraphs.map((paragraph) => paragraph.text).join(" "),
    );
    if (recoveryViability.usable) {
      diagnostics.splice(0, diagnostics.length, ...recoveryDiagnostics);
      recoveryState.diagnostics = diagnostics;
      state = recoveryState;
      sourceDocumentCount = recoveryDocumentCount;
    }
  }

  if (state.paragraphs.length === 0) {
    throw new EpubParseError("No / unusable text", "EPUB contains no readable text");
  }
  const provisionalBook = buildBook({
    format: "epub",
    metadata: packageData.metadata,
    paragraphs: state.paragraphs,
    chapters: [],
    images: [],
    cover: state.cover,
    diagnostics: [],
    timings: { totalMs: 0 },
  });
  if (provisionalBook.totals.words < 3) {
    throw new EpubParseError(
      "No / unusable text",
      `EPUB contains too little readable text (${provisionalBook.totals.words} words)`,
    );
  }

  await options.onPhaseChange?.("building_chapters");
  const chapters = chooseChapterSource(
    parseNavigationChapters(state),
    parseNcxChapters(state),
    state.headings,
    state.fileChapters,
    state.paragraphs.length,
    packageData.metadata.title,
    diagnostics,
  );
  checkDeadline(deadline, timeoutMs);

  const contentMs = performance.now() - startedAt - openMs - structureMs;
  const totalMs = performance.now() - startedAt;
  const book = buildBook({
    format: "epub",
    metadata: packageData.metadata,
    paragraphs: state.paragraphs,
    chapters,
    images: state.images,
    cover: state.cover,
    diagnostics,
    timings: { totalMs, openMs, structureMs, contentMs },
  });

  return {
    book,
    internals: {
      sourceDocumentCount,
      // Count content-referenced resources, excluding unused manifest art and cover.
      declaredImageCount: state.contentImageReferences.size,
      extractedImageCount: book.images.length,
    },
  };
}
