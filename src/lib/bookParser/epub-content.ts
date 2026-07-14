import { basename } from "./path.ts";

import { load } from "cheerio";

import { countWords, decodeSafeUriComponent, normalizeText } from "./text.ts";
import type { BookImage, Cover, Paragraph, ParserDiagnostic } from "./types.ts";
import {
  checkDeadline,
  decodeMarkup,
  normalizeArchivePath,
  parseReference,
  type SelectiveZipArchive,
} from "./epub-archive.ts";
import { isContentDocument } from "./epub-package.ts";
import {
  COVERISH,
  EpubParseError,
  MAX_CONTENT_ENTRY_BYTES,
  MAX_IMAGE_WARNINGS,
  MAX_INLINE_IMAGE_CHARACTERS,
  MAX_SVG_ASSET_BYTES,
  MAX_STYLESHEET_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
  elementsByLocalName,
  fileChapterTitle,
  hasReadableText,
  inferImageMediaType,
  isContentMediaType,
  isImageMediaType,
  isSaneChapterTitle,
  loadDocument,
  localName,
  mediaTypeForPath,
  normalizeImageMediaType,
  toCover,
  type DomNode,
  type ExtractionState,
  type LoadedDocument,
  type ManifestItem,
  type PackageData,
  type ResolvedMedia,
} from "./epub-shared.ts";

const MEDIA_SELECTOR = "img,picture,object,embed,input,video,svg";
const FLOW_BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "div",
  "dt", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "li",
  "main", "p", "pre", "section", "td", "th",
]);
const IGNORED_TEXT_ELEMENTS = new Set([
  "audio", "canvas", "head", "noscript", "rp", "rt", "script", "style", "template",
]);

interface MediaReferenceCandidate {
  reference: string;
  basePath: string;
}

type StylesheetMediaReferences = Map<DomNode, MediaReferenceCandidate[]>;

interface CoverCandidate {
  path: string;
  mediaType: string;
}

export function createExtractionState(
  archive: SelectiveZipArchive,
  packageData: PackageData,
  diagnostics: ParserDiagnostic[],
  deadline: number,
  timeoutMs: number,
): ExtractionState {
  return {
    archive,
    packageData,
    paragraphs: [],
    images: [],
    headings: [],
    fileChapters: [],
    fileStarts: new Map(),
    anchors: new Map(),
    cover: null,
    diagnostics,
    imageWarningKeys: new Set(),
    mediaCache: new Map(),
    svgResolutionStack: new Set(),
    imageKeys: new Set(),
    contentImageSources: new Set(),
    contentImageReferences: new Set(),
    pendingSceneBreakSource: null,
    cssSeparatorElements: new Set(),
    deadline,
    timeoutMs,
  };
}

export async function discoverCover(state: ExtractionState): Promise<Cover | null> {
  const { packageData, archive } = state;
  const candidates: CoverCandidate[] = [];
  const appendItem = (item: ManifestItem | undefined): void => {
    if (item?.path) candidates.push({ path: item.path, mediaType: item.mediaType });
  };

  appendItem(packageData.manifest.find((item) => item.properties.has("cover-image")));
  appendItem(
    packageData.epub2CoverId
      ? packageData.manifestById.get(packageData.epub2CoverId)
      : undefined,
  );
  for (const path of packageData.guideCoverPaths) {
    candidates.push({ path, mediaType: mediaTypeForPath(path, packageData) ?? "" });
  }
  for (const item of packageData.manifest) {
    if (COVERISH.test(`${item.id} ${basename(item.path ?? item.href)}`)) appendItem(item);
  }

  const firstSpine = packageData.spine[0]?.item;
  if (firstSpine && COVERISH.test(`${firstSpine.id} ${firstSpine.href}`)) appendItem(firstSpine);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolvedPath = archive.resolve(candidate.path);
    if (resolvedPath === null || seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    if (isContentMediaType(candidate.mediaType, resolvedPath)) {
      const cover = await coverFromWrapper(resolvedPath, state);
      if (cover !== null) return cover;
      continue;
    }
    const media = await resolveMediaPath(resolvedPath, state, false);
    if (media !== null) return toCover(media);
  }

  // A nameless first-spine image-only wrapper is a common generated cover page.
  if (firstSpine?.path) {
    const firstPath = archive.resolve(firstSpine.path);
    if (firstPath !== null && isContentDocument(firstSpine, firstPath)) {
      const inferred = await coverFromWrapper(firstPath, state, true);
      if (inferred !== null) return inferred;
    }
  }
  return null;
}

async function coverFromWrapper(
  documentPath: string,
  state: ExtractionState,
  requireImageOnly = false,
): Promise<Cover | null> {
  let markup: string;
  try {
    markup = decodeMarkup(state.archive.read(documentPath, MAX_CONTENT_ENTRY_BYTES));
  } catch {
    return null;
  }
  const $ = loadDocument(markup, documentPath);
  const body = elementsByLocalName($, "body").first();
  const root = body.length > 0 ? body : $.root();
  const visibleText = normalizeText(root.text());
  const candidates = root.find(MEDIA_SELECTOR).toArray();
  const hasProseBlock = root
    .find("p,blockquote,li,pre")
    .toArray()
    .some((element) => countWords(normalizeText($(element).text())) >= 3);
  if (requireImageOnly && (countWords(visibleText) > 16 || candidates.length > 4 || hasProseBlock)) return null;
  for (const element of candidates) {
    const media = await mediaForElement($, element, documentPath, state, false);
    if (media.length > 0) return toCover(media[0]!);
  }
  return null;
}

export async function extractContentDocument(
  markup: string,
  documentPath: string,
  mediaType: string,
  spineIndex: number,
  state: ExtractionState,
): Promise<void> {
  const $ = loadDocument(markup, documentPath, mediaType);
  const body = elementsByLocalName($, "body").first();
  const root = body.length > 0 ? body : $.root();
  const stylesheetMedia = await collectStylesheetMediaReferences(
    $,
    root.find("*").add(root).toArray(),
    documentPath,
    state,
  );
  root.find("script,noscript,template,style,head").remove();
  root
    .find("[hidden],[aria-hidden]")
    .filter((_index, element) => {
      const hidden = $(element).attr("hidden");
      const ariaHidden = ($(element).attr("aria-hidden") ?? "").toLocaleLowerCase();
      return hidden !== undefined || ariaHidden === "true";
    })
    .remove();
  root
    .find("[style]")
    .filter((_index, element) => isCssHidden($(element).attr("style") ?? ""))
    .remove();

  const beforeDocument = state.paragraphs.length;
  const firstHeading = { value: "" };
  const rootNode = root.get(0);
  if (rootNode) {
    await extractFlowElement(
      $,
      rootNode as DomNode,
      documentPath,
      state,
      stylesheetMedia,
      firstHeading,
      true,
    );
  }

  if (state.paragraphs.length > beforeDocument) {
    const startParagraphId = beforeDocument + 1;
    state.fileStarts.set(documentPath, startParagraphId);
    state.fileChapters.push({
      title: firstHeading.value || fileChapterTitle(documentPath, spineIndex),
      startParagraphId,
    });
  }
}

async function collectStylesheetMediaReferences(
  $: LoadedDocument,
  contentElements: DomNode[],
  documentPath: string,
  state: ExtractionState,
): Promise<StylesheetMediaReferences> {
  const result: StylesheetMediaReferences = new Map();
  const contentSet = new Set(contentElements);
  const stylesheets: Array<{ css: string; basePath: string }> = [];

  for (const style of elementsByLocalName($, "style").toArray()) {
    const css = $(style).text();
    if (css.trim()) stylesheets.push({ css, basePath: documentPath });
  }

  for (const link of elementsByLocalName($, "link").toArray()) {
    const relation = ($(link).attr("rel") ?? "").toLocaleLowerCase().split(/\s+/u);
    const href = $(link).attr("href")?.trim();
    if (!relation.includes("stylesheet") || !href) continue;
    const parsed = parseReference(documentPath, href);
    const stylesheetPath = parsed.path ? state.archive.resolve(parsed.path) : null;
    if (stylesheetPath === null) continue;
    try {
      stylesheets.push({
        css: decodeMarkup(state.archive.read(stylesheetPath, MAX_STYLESHEET_BYTES)),
        basePath: stylesheetPath,
      });
    } catch (error) {
      if (error instanceof EpubParseError) throw error;
    }
  }

  for (const stylesheet of stylesheets) {
    for (const selector of cssSeparatorSelectors(stylesheet.css)) {
      try {
        for (const element of $(selector).toArray()) {
          if (contentSet.has(element)) state.cssSeparatorElements.add(element);
        }
      } catch {
        // Unsupported selectors are ignored just like unsupported image rules.
      }
    }
    for (const rule of cssImageRules(stylesheet.css)) {
      for (const selector of rule.selectors) {
        let matches: DomNode[];
        try {
          matches = $(selector).toArray().filter((element) => contentSet.has(element));
        } catch {
          continue;
        }
        for (const element of matches) {
          const current = result.get(element) ?? [];
          for (const reference of rule.references) {
            const candidate = { reference, basePath: stylesheet.basePath };
            if (!current.some((entry) =>
              entry.reference === candidate.reference && entry.basePath === candidate.basePath
            )) {
              current.push(candidate);
            }
          }
          if (current.length > 0) result.set(element, current);
        }
      }
    }
  }
  return result;
}

function cssSeparatorSelectors(css: string): string[] {
  const selectors: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectorText = match[1]?.trim() ?? "";
    const declarations = match[2] ?? "";
    if (!selectorText || selectorText.startsWith("@")) continue;
    const narrowRule = /border-(?:top|bottom)\s*:\s*(?!0|none)/iu.test(declarations)
      && /(?:width|max-width)\s*:\s*(?:[1-9]\d?|100)(?:px|%|em|rem)/iu.test(declarations);
    const pairedMargins = cssLengthAtLeast(declarations, "margin-(?:top|block-start)", 1)
      && cssLengthAtLeast(declarations, "margin-(?:bottom|block-end)", 1);
    const centeredSpacing = /text-align\s*:\s*center/iu.test(declarations)
      && (pairedMargins || cssLengthAtLeast(declarations, "min-height", 1));
    const classScopedMarginGap = pairedMargins && /[.#][\w-]+/u.test(selectorText);
    const content = /content\s*:\s*(['"])(.*?)\1/iu.exec(declarations)?.[2] ?? "";
    if (!narrowRule && !centeredSpacing && !classScopedMarginGap && !isSceneOrnamentText(content)) continue;
    selectors.push(...selectorText
      .split(",")
      .map((selector) => selector.replace(/::(?:before|after|marker)\b.*$/iu, "").trim())
      .filter(Boolean));
  }
  return selectors;
}

function cssLengthAtLeast(declarations: string, propertyPattern: string, minimumEm: number): boolean {
  const match = new RegExp(`${propertyPattern}\\s*:\\s*(\\d+(?:\\.\\d+)?)(em|rem)`, "iu").exec(declarations);
  return match?.[1] !== undefined && Number(match[1]) >= minimumEm;
}

function cssImageRules(css: string): Array<{ selectors: string[]; references: string[] }> {
  const result: Array<{ selectors: string[]; references: string[] }> = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectorText = match[1]?.trim() ?? "";
    const declarations = match[2] ?? "";
    if (!selectorText || selectorText.startsWith("@")) continue;
    if (!/(?:^|;)\s*(?:background(?:-image)?|content)\s*:/iu.test(declarations)) continue;
    const references = [...declarations.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)]
      .map((entry) => entry[2]?.trim() ?? "")
      .filter(Boolean);
    if (references.length === 0) continue;
    const selectors = selectorText
      .split(",")
      .map((selector) => selector.replace(/::(?:before|after|marker)\b.*$/iu, "").trim())
      .filter(Boolean);
    if (selectors.length > 0) result.push({ selectors, references });
  }
  return result;
}

async function extractFlowElement(
  $: LoadedDocument,
  element: DomNode,
  documentPath: string,
  state: ExtractionState,
  stylesheetMedia: StylesheetMediaReferences,
  firstHeading: { value: string },
  isRoot = false,
): Promise<void> {
  checkDeadline(state.deadline, state.timeoutMs);
  registerElementAnchor($, element, documentPath, state);

  const tag = localName(element);
  if (IGNORED_TEXT_ELEMENTS.has(tag)) return;

  if (tag === "hr") {
    recordSceneBreak(state, "horizontal-rule");
    return;
  }

  const elementText = normalizeText($(element).text());
  if (isSceneOrnamentText(elementText) && $(element).find(MEDIA_SELECTOR).length === 0) {
    recordSceneBreak(state, "text-ornament");
    return;
  }
  if (
    elementText.length === 0
    && $(element).find(MEDIA_SELECTOR).length === 0
    && hasCssSeparatorSignal($, element, state)
  ) {
    recordSceneBreak(state, "css-separator");
    return;
  }

  let buffer = "";
  let pendingPunctuation = "";
  let firstParagraphId: number | null = null;
  const emittedTexts: string[] = [];
  const flushText = (): void => {
    const groups = buffer.includes("\n\n") ? buffer.split(/\n\s*\n+/u) : [buffer];
    buffer = "";
    for (const group of groups) {
      const text = normalizeText(group);
      if (!hasReadableText(text)) {
        if (text) pendingPunctuation = normalizeText(`${pendingPunctuation} ${text}`);
        continue;
      }
      const paragraphText = pendingPunctuation
        ? normalizeText(`${pendingPunctuation}${/^\s/u.test(group) ? " " : ""}${text}`)
        : text;
      pendingPunctuation = "";
      const paragraphId = state.paragraphs.length + 1;
      const previousParagraph = state.paragraphs.at(-1);
      const sceneBreakBefore = state.pendingSceneBreakSource
        && previousParagraph !== undefined
        && countWords(previousParagraph.text) >= 8
        && countWords(paragraphText) >= 8
        ? state.pendingSceneBreakSource
        : null;
      state.paragraphs.push({
        id: paragraphId,
        text: paragraphText,
        ...(sceneBreakBefore ? { sceneBreakBefore } : {}),
      });
      state.pendingSceneBreakSource = null;
      firstParagraphId ??= paragraphId;
      emittedTexts.push(paragraphText);
    }
  };

  const appendNode = async (node: DomNode): Promise<void> => {
    checkDeadline(state.deadline, state.timeoutMs);
    const nodeType = (node as { type?: string }).type;
    if (nodeType === "text") {
      buffer += (node as { data?: string }).data ?? "";
      return;
    }

    const nodeTag = localName(node);
    if (!nodeTag || IGNORED_TEXT_ELEMENTS.has(nodeTag)) return;
    if (nodeTag === "br") {
      registerElementAnchor($, node, documentPath, state);
      buffer += "\n";
      return;
    }

    if (nodeTag === "hr") {
      flushText();
      recordSceneBreak(state, "horizontal-rule");
      return;
    }

    if (FLOW_BLOCK_ELEMENTS.has(nodeTag)) {
      flushText();
      await extractFlowElement(
        $,
        node,
        documentPath,
        state,
        stylesheetMedia,
        firstHeading,
      );
      return;
    }

    const stylesheetCandidates = stylesheetMedia.get(node) ?? [];
    const nativeMedia = isMediaElement($, node);
    const inlineCssMedia = firstCssImageReference($(node).attr("style") ?? "") !== null;
    if (nativeMedia || stylesheetCandidates.length > 0 || inlineCssMedia) {
      flushText();
      registerElementAnchor($, node, documentPath, state);
      const media = await mediaForElement(
        $,
        node,
        documentPath,
        state,
        true,
        stylesheetCandidates,
      );
      const alt = imageAlt($, node);
      for (const resolved of media) appendBookImage(resolved, alt, state);
      if (nativeMedia && (media.length > 0 || !["object", "picture"].includes(nodeTag))) return;
    } else {
      registerElementAnchor($, node, documentPath, state);
    }

    for (const child of $(node).contents().toArray()) {
      await appendNode(child as DomNode);
    }
  };

  const ownStylesheetCandidates = stylesheetMedia.get(element) ?? [];
  const ownInlineCssMedia = firstCssImageReference($(element).attr("style") ?? "") !== null;
  if (ownStylesheetCandidates.length > 0 || ownInlineCssMedia) {
    const media = await mediaForElement(
      $,
      element,
      documentPath,
      state,
      true,
      ownStylesheetCandidates,
    );
    const alt = imageAlt($, element);
    for (const resolved of media) appendBookImage(resolved, alt, state);
  }

  for (const child of $(element).contents().toArray()) {
    await appendNode(child as DomNode);
  }
  flushText();

  if (!isRoot && firstParagraphId !== null && /^h[1-6]$/u.test(tag)) {
    const title = normalizeText(emittedTexts.join(" "));
    if (isSaneChapterTitle(title)) {
      state.headings.push({ title, startParagraphId: firstParagraphId });
      if (!firstHeading.value) firstHeading.value = title;
    }
  }
}

function recordSceneBreak(
  state: ExtractionState,
  source: NonNullable<Paragraph["sceneBreakBefore"]>,
): void {
  if (state.paragraphs.length === 0) return;
  state.pendingSceneBreakSource ??= source;
}

/** A standalone ornament is structural; the same glyphs inside prose are not. */
export function isSceneOrnamentText(value: string): boolean {
  const compact = normalizeText(value);
  if (compact.length === 0 || /[\p{L}\p{N}]/u.test(compact)) return false;
  if (/^[\u2042\u2766\u2767]$/u.test(compact)) return true;
  const symbols = compact.match(/[\*\u2042\u2022\u25C6\u25C7\u25CA\u2766\u2767\u00B7]/gu) ?? [];
  return symbols.length >= 3
    && compact.replace(/[\s*\u2042\u2022\u25C6\u25C7\u25CA\u2766\u2767\u00B7—–_-]/gu, "").length === 0;
}

function hasCssSeparatorSignal($: LoadedDocument, element: DomNode, state: ExtractionState): boolean {
  if (state.cssSeparatorElements.has(element)) return true;
  const descriptor = `${$(element).attr("class") ?? ""} ${$(element).attr("id") ?? ""}`;
  if (/(?:^|[\s_-])(?:asterism|scene[-_ ]?break|separator|divider|ornament)(?:$|[\s_-])/iu.test(descriptor)) {
    return true;
  }
  const style = $(element).attr("style") ?? "";
  return /border-(?:top|bottom)\s*:/iu.test(style)
    && /(?:width|max-width)\s*:\s*(?:[1-9]\d?|100)(?:px|%|em|rem)/iu.test(style);
}

function registerElementAnchor(
  $: LoadedDocument,
  element: DomNode,
  documentPath: string,
  state: ExtractionState,
): void {
  const elementId =
    $(element).attr("id") ?? $(element).attr("xml:id") ?? $(element).attr("name");
  if (!elementId) return;
  const key = anchorKey(documentPath, decodeSafeUriComponent(elementId));
  if (!state.anchors.has(key)) state.anchors.set(key, state.paragraphs.length + 1);
}

function isMediaElement($: LoadedDocument, element: DomNode): boolean {
  const tag = localName(element);
  if (!["img", "picture", "object", "embed", "input", "video", "svg"].includes(tag)) return false;
  return tag !== "input" || ($(element).attr("type") ?? "").toLocaleLowerCase() === "image";
}

async function mediaForElement(
  $: LoadedDocument,
  element: DomNode,
  documentPath: string,
  state: ExtractionState,
  reportFailures: boolean,
  stylesheetCandidates: MediaReferenceCandidate[] = [],
): Promise<ResolvedMedia[]> {
  const tag = localName(element);
  const node = $(element);
  const references: MediaReferenceCandidate[] = [...stylesheetCandidates];
  let inlineSvg: string | null = null;

  if (tag === "img") {
    const srcset = bestSrcsetCandidate(node.attr("srcset") ?? node.attr("data-srcset") ?? "");
    const source =
      srcset ??
      firstNonemptyAttribute(node, ["src", "data-src", "data-original", "data-lazy-src"]);
    if (source) references.push({ reference: source, basePath: documentPath });
  } else if (tag === "picture") {
    const source = node.find("source[srcset],source[src]").first();
    const fallback = node.find("img[srcset],img[src]").first();
    const value =
      bestSrcsetCandidate(source.attr("srcset") ?? "") ??
      source.attr("src") ??
      bestSrcsetCandidate(fallback.attr("srcset") ?? "") ??
      fallback.attr("src");
    if (value) references.push({ reference: value, basePath: documentPath });
  } else if (tag === "object") {
    const value = node.attr("data");
    if (value) references.push({ reference: value, basePath: documentPath });
  } else if (tag === "embed") {
    const value = node.attr("src");
    if (value) references.push({ reference: value, basePath: documentPath });
  } else if (tag === "input" && (node.attr("type") ?? "").toLocaleLowerCase() === "image") {
    const value = node.attr("src");
    if (value) references.push({ reference: value, basePath: documentPath });
  } else if (tag === "video") {
    const value = node.attr("poster");
    if (value) references.push({ reference: value, basePath: documentPath });
  } else if (tag === "svg") {
    inlineSvg = $.html(element);
  }

  const cssReference = firstCssImageReference(node.attr("style") ?? "");
  if (cssReference) references.push({ reference: cssReference, basePath: documentPath });
  const result: ResolvedMedia[] = [];
  for (const candidate of deduplicateReferenceCandidates(references)) {
    const media = await resolveMediaReference(
      candidate.reference,
      candidate.basePath,
      state,
      reportFailures,
    );
    if (reportFailures) {
      trackContentImageReference(candidate.reference, candidate.basePath, media, state);
    }
    if (media !== null) result.push(media);
  }
  if (inlineSvg !== null) {
    const media = await resolveInlineSvg(inlineSvg, documentPath, state, reportFailures);
    if (reportFailures && media?.src !== state.cover?.src) {
      state.contentImageReferences.add(
        media?.src ?? `${documentPath}\u0000inline-svg-${state.contentImageReferences.size + 1}`,
      );
    }
    if (media !== null) result.push(media);
  }
  return deduplicateMedia(result);
}

async function resolveMediaReference(
  reference: string,
  basePath: string,
  state: ExtractionState,
  reportFailures: boolean,
): Promise<ResolvedMedia | null> {
  const parsed = parseReference(basePath, reference);
  if (parsed.dataUrl !== null) {
    const mediaType = dataUrlMediaType(parsed.dataUrl);
    if (
      mediaType !== null &&
      SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType) &&
      parsed.dataUrl.length <= MAX_INLINE_IMAGE_CHARACTERS
    ) {
      return { src: parsed.dataUrl, mediaType };
    }
    if (reportFailures) addImageWarning(state, reference, "Inline image is unsupported or too large");
    return null;
  }
  if (parsed.path === null) {
    if (reportFailures) addImageWarning(state, reference, "External or invalid image reference was skipped");
    return null;
  }
  const resolved = state.archive.resolve(parsed.path);
  if (resolved === null) {
    if (reportFailures) addImageWarning(state, parsed.path, "Referenced image is absent from the EPUB");
    return null;
  }
  return resolveMediaPath(resolved, state, reportFailures);
}

async function resolveMediaPath(
  path: string,
  state: ExtractionState,
  reportFailures: boolean,
): Promise<ResolvedMedia | null> {
  const resolved = state.archive.resolve(path);
  if (resolved === null) return null;
  const cached = state.mediaCache.get(resolved);
  if (cached !== undefined || state.mediaCache.has(resolved)) return cached ?? null;

  const mediaType = mediaTypeForPath(resolved, state.packageData);
  if (!isImageMediaType(mediaType ?? "", resolved)) {
    if (reportFailures) addImageWarning(state, resolved, "Referenced resource is not a supported image");
    state.mediaCache.set(resolved, null);
    return null;
  }
  if ((mediaType ?? inferImageMediaType(resolved)) === "image/svg+xml") {
    return resolveSvgAsset(resolved, state, reportFailures);
  }
  const media: ResolvedMedia = { src: resolved };
  const normalizedMediaType = normalizeImageMediaType(mediaType ?? inferImageMediaType(resolved));
  if (normalizedMediaType) media.mediaType = normalizedMediaType;
  state.mediaCache.set(resolved, media);
  return media;
}

async function resolveSvgAsset(
  path: string,
  state: ExtractionState,
  reportFailures: boolean,
): Promise<ResolvedMedia | null> {
  if (state.svgResolutionStack.has(path)) {
    if (reportFailures) addImageWarning(state, path, "Recursive SVG image reference was skipped");
    return null;
  }
  state.svgResolutionStack.add(path);
  try {
    const markup = decodeMarkup(state.archive.read(path, MAX_SVG_ASSET_BYTES));
    const wrapperReference = svgWrapperReference(markup);
    if (wrapperReference !== null) {
      const unwrapped = await resolveMediaReference(wrapperReference, path, state, reportFailures);
      state.mediaCache.set(path, unwrapped);
      return unwrapped;
    }
    if (hasExternalSvgReferences(markup)) {
      if (reportFailures) {
        addImageWarning(
          state,
          path,
          "SVG asset has external dependencies that cannot be represented by one stable pointer",
        );
      }
      state.mediaCache.set(path, null);
      return null;
    }
    const media: ResolvedMedia = { src: path, mediaType: "image/svg+xml" };
    state.mediaCache.set(path, media);
    return media;
  } catch (error) {
    if (error instanceof EpubParseError) throw error;
    if (reportFailures) addImageWarning(state, path, "SVG asset could not be inspected");
    state.mediaCache.set(path, null);
    return null;
  } finally {
    state.svgResolutionStack.delete(path);
  }
}

async function resolveInlineSvg(
  markup: string,
  documentPath: string,
  state: ExtractionState,
  reportFailures: boolean,
): Promise<ResolvedMedia | null> {
  const wrapperReference = svgWrapperReference(markup);
  if (wrapperReference !== null) {
    return resolveMediaReference(wrapperReference, documentPath, state, reportFailures);
  }
  if (markup.length > MAX_INLINE_IMAGE_CHARACTERS) {
    if (reportFailures) addImageWarning(state, documentPath, "Large inline SVG was skipped");
    return null;
  }
  if (hasExternalSvgReferences(markup)) {
    if (reportFailures) addImageWarning(state, documentPath, "Inline SVG with external dependencies was skipped");
    return null;
  }
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
    mediaType: "image/svg+xml",
  };
}

function svgWrapperReference(markup: string): string | null {
  const $ = load(markup, { xml: true });
  const svg = elementsByLocalName($, "svg").first();
  if (svg.length === 0) return null;
  const imageElements = svg
    .find("*")
    .filter((_index, element) => localName(element) === "image")
    .toArray();
  if (imageElements.length !== 1) return null;
  const visualSiblings = svg
    .find("*")
    .toArray()
    .filter((element) =>
      ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "use", "foreignobject"].includes(
        localName(element),
      ),
    );
  if (visualSiblings.length > 0) return null;
  const image = $(imageElements[0]!);
  return image.attr("href") ?? image.attr("xlink:href") ?? null;
}

function hasExternalSvgReferences(markup: string): boolean {
  const $ = load(markup, { xml: true });
  return elementsByLocalName($, "svg")
    .first()
    .find("[href],[xlink\\:href]")
    .toArray()
    .some((element) => {
      const value = ($(element).attr("href") ?? $(element).attr("xlink:href") ?? "").trim();
      return value.length > 0 && !value.startsWith("#") && !value.startsWith("data:image/");
    });
}

function appendBookImage(media: ResolvedMedia, alt: string, state: ExtractionState): void {
  if (state.cover?.src === media.src) return;
  state.contentImageSources.add(media.src);
  const afterParagraphId = state.paragraphs.length;
  const key = `${media.src}\u0000${afterParagraphId}`;
  if (state.imageKeys.has(key)) return;
  state.imageKeys.add(key);
  const image: BookImage = { afterParagraphId, alt, src: media.src };
  if (media.mediaType) image.mediaType = media.mediaType;
  state.images.push(image);
}

function trackContentImageReference(
  reference: string,
  documentPath: string,
  media: ResolvedMedia | null,
  state: ExtractionState,
): void {
  if (media !== null && media.src === state.cover?.src) return;
  const parsed = parseReference(documentPath, reference);
  const key =
    parsed.dataUrl ??
    (parsed.path
      ? state.archive.resolve(parsed.path) ?? parsed.path
      : `${documentPath}\u0000${reference}`);
  state.contentImageReferences.add(key);
}

function imageAlt($: LoadedDocument, element: DomNode): string {
  const node = $(element);
  const direct = firstNonemptyAttribute(node, ["alt", "aria-label", "title"]);
  if (direct) return normalizeText(direct).slice(0, 500);
  const svgDescription = node
    .find("title,desc")
    .toArray()
    .map((child) => normalizeText($(child).text()))
    .find(Boolean);
  if (svgDescription) return svgDescription.slice(0, 500);
  const caption = node.closest("figure").find("figcaption").first().text();
  return normalizeText(caption).slice(0, 500);
}

function firstNonemptyAttribute(
  element: ReturnType<LoadedDocument>,
  names: string[],
): string | null {
  for (const name of names) {
    const value = element.attr(name)?.trim();
    if (value) return value;
  }
  return null;
}

function bestSrcsetCandidate(value: string): string | null {
  const candidates = value
    .split(/\s*,\s*/u)
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/u);
      const url = parts[0] ?? "";
      const descriptor = parts[1] ?? "1x";
      const parsed = Number.parseFloat(descriptor);
      return { url, score: Number.isFinite(parsed) ? parsed : 1 };
    })
    .filter((candidate) => candidate.url.length > 0 && !candidate.url.startsWith("data:"));
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.url ?? null;
}

function firstCssImageReference(style: string): string | null {
  const declaration = /(?:^|;)\s*(?:background(?:-image)?|content)\s*:[^;]*/giu.exec(style)?.[0];
  if (!declaration) return null;
  const match = /url\(\s*(['"]?)(.*?)\1\s*\)/iu.exec(declaration);
  return match?.[2]?.trim() || null;
}

function dataUrlMediaType(value: string): string | null {
  const match = /^data:([^;,]+)[;,]/iu.exec(value);
  return normalizeImageMediaType(match?.[1] ?? null);
}

function deduplicateMedia(media: ResolvedMedia[]): ResolvedMedia[] {
  const seen = new Set<string>();
  return media.filter((item) => {
    if (seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
}

function deduplicateReferenceCandidates(
  candidates: MediaReferenceCandidate[],
): MediaReferenceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const reference = candidate.reference.trim();
    if (!reference) return false;
    const key = `${candidate.basePath}\u0000${reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    candidate.reference = reference;
    return true;
  });
}

function addImageWarning(state: ExtractionState, key: string, message: string): void {
  const diagnosticKey = `${message}\u0000${key}`;
  if (state.imageWarningKeys.has(diagnosticKey)) return;
  state.imageWarningKeys.add(diagnosticKey);
  if (state.imageWarningKeys.size > MAX_IMAGE_WARNINGS) return;
  state.diagnostics.push({
    bucket: "Images missing / blank / badly placed",
    // Phase 1 is strict: an unresolved referenced image would render blank.
    severity: "failure",
    message,
    details: { reference: key },
  });
}

function isCssHidden(style: string): boolean {
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu.test(style);
}

function anchorKey(path: string, fragment: string): string {
  return `${normalizeArchivePath(path)}#${fragment}`;
}
