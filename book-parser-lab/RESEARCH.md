# Book Parser Lab — Structure and Image Research

This note records the variants considered in phase 1 and the reason for each
normalization rule. It is intentionally implementation-facing: the parser does
not attempt to reproduce a browser or PDF viewer.

## Primary references

- [W3C EPUB 3.3](https://www.w3.org/TR/epub-33/) defines the ZIP container,
  package manifest, spine reading order, EPUB navigation document, legacy NCX
  support, XHTML/SVG content, and reflowable versus fixed layout.
- [PDF.js `PDFPageProxy`](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html)
  exposes text content, the page operator list, and the structure tree. Those
  are separate views of a page; PDF does not directly provide app-style
  paragraphs or image-to-paragraph anchors.
- [Project Gutenberg robot access](https://www.gutenberg.org/policy/robot_access.html)
  documents its permitted harvest endpoint and mirror-based bulk downloads.
  [Its offline-catalog page](https://www.gutenberg.org/ebooks/offline_catalogs.html)
  documents the official CSV/RDF metadata feeds.
- [DOAB metadata documentation](https://www.doabooks.org/en/resources/metadata-harvesting-and-content-dissemination)
  documents its REST and OAI-PMH interfaces. DOAB records include open-access
  status, license metadata, language, type, and publisher download links.
- [Internet Archive item metadata API](https://doc-tools.readthedocs.io/en/ia-test-gsod/md-read.html)
  documents the file-level metadata used only as a fallback source when an
  explicitly licensed text PDF is not available through DOAB.

## EPUB structure taxonomy

| Variant | Extraction rule | Main failure if ignored |
|---|---|---|
| EPUB 2 package + NCX | Read `container.xml`, OPF manifest/spine, then NCX targets | Missing or file-boundary-only chapters |
| EPUB 3 package + nav | Prefer the `nav` manifest item and the `toc` navigation tree | Missing nested/descriptive chapter labels |
| Both nav and NCX | Prefer usable nav; fall back to NCX if targets do not resolve | Duplicate navigation entries |
| Weak or absent TOC | Use heading anchors, then meaningful spine-file boundaries | One fake chapter or hundreds of file-name chapters |
| One large XHTML file | Preserve block boundaries and anchor IDs inside the file | Whole book collapsed into one paragraph |
| Many XHTML files | Follow linear spine order, not ZIP or manifest order | Scrambled reading order |
| Nested `div` soup | Emit semantic blocks; use text-bearing leaf containers as fallback | Duplicate ancestor/child text or missing prose |
| Fixed-layout metadata | Fail clearly in phase 1 | Apparently successful but unusable extraction |
| Non-linear auxiliary spine items | Do not let them reorder the linear book | TOC/cover duplicated in the prose stream |

Navigation labels are kept as the publication supplies them. The Pride golden
book deliberately uses labels that combine an illustration caption and chapter
name, and the accepted app screenshot displays those labels.

## EPUB image taxonomy

| Embedding pattern | Pointer/handling policy | Blank/duplicate risk |
|---|---|---|
| `<img src>` | Resolve against the containing XHTML path and retain a ZIP-relative pointer | Incorrect `../` resolution |
| `<picture>` / `srcset` | Select a supported local candidate once; avoid separately emitting its fallback | Duplicate image |
| Inline SVG wrapping one `<image href>` | Emit the referenced raster/SVG asset pointer, not a serialized wrapper | Relative `href` becomes blank inside a `data:` URL |
| Self-contained inline SVG | Keep a small inline SVG data URL | Oversized database text or external references breaking |
| Standalone SVG asset | Keep its ZIP-relative pointer | Treating text/XML as an unsupported raster |
| `<object data>` / `<embed src>` | Accept supported local image media with fallback suppression | Missing publisher-specific image wrappers |
| Inline, embedded, or linked CSS `background-image` | Match the rule to its content element, resolve URLs relative to the XHTML or stylesheet, and anchor before that element's text | Decorative assets mistaken for content |
| Data URI image | Keep only when already inline and reasonably small | Reintroducing eager materialization cost |
| Spine cover wrapper | Discover the library cover, suppress duplicate cover-only sidecar content | Cover appears twice or no library cover |
| Remote image | Record a diagnostic; do not make import depend on a network fetch | Offline blank space and unstable content |

For all forms, the parser anchors the image after the latest emitted paragraph
at its DOM position. When an image splits inline prose, text is flushed before
the image and subsequent prose becomes a new paragraph so the sidecar order
remains monotonic. Mixed nested containers preserve direct text before and after
their child blocks. Alt text comes from the image, wrapper, nearby figure
caption, or an empty string; it is never synthesized from the filename as if it
were publisher text.

Standalone SVG assets remain pointers only when they are self-contained. A
simple one-image wrapper is unwrapped to that referenced asset; a more complex
SVG with external dependencies fails strict phase-1 validation because the
production blob URL loader cannot resolve ZIP-relative dependencies from an
isolated SVG blob.

## PDF structure and image taxonomy

PDF text operators describe glyph placement, not semantic paragraphs. The lab
groups text by page coordinates, filters repeating page furniture, joins
line-wrapped prose conservatively, and uses outlines or heading-size evidence
for chapters. A low-text, image-dominated document is reported as scanned or
unusable because OCR is deliberately out of scope.

PDF images commonly appear as reusable image XObjects, inline image operators,
image masks, or repeated form content. The stable app-side reference is
`pdf://page/<page>/image/<index>` with optional object metadata. The phase-1
anchor is derived from the image operator's position among text-show operators
on the same page; this is approximate but keeps the sidecar monotonic without
decoding every image. Tiny masks and repeated decorative resources should not
be promoted to full illustrations.

Known strict-failure cases include multi-column reading order that cannot be
resolved confidently, encrypted/DRM content, text made only from vector paths,
broken font maps producing replacement characters, scanned pages without a
usable text layer, and a page/operator stream that exceeds the 30-second book
ceiling.

## Efficiency rules

1. EPUB in-book media stays ZIP-relative; PDF media stays page/object-relative.
2. The parser reads text/structure and image references, not every image byte.
3. Only one library cover may be materialized later by an integration layer.
4. Validation rejects large in-book `data:` payloads and non-monotonic anchors.
5. Every corpus parse runs in a killable child process with a hard 30-second
   ceiling, so one pathological file cannot stall the batch.

## Corpus rationale

The EPUB slice uses publisher-produced and generated public-domain variants
from Project Gutenberg's permitted mirror harvest. The PDF slice uses actual
open-access books indexed by DOAB/OAPEN and retains the per-title license URL.
This creates realistic variation without intentionally corrupting files or
using commercial/pirated catalogs. Download selection is deterministic,
resumable, validates file signatures, and records source URLs in the manifest.
Downloaded PDF candidates also receive a bounded PDF.js text-layer scope check.
The manifest persists its page/word/character evidence: image-only or extremely
sparse-text PDFs are marked `excluded` and replaced, while screening errors are
kept as indeterminate candidates so genuine parser failures are not selected out.

## Empirical findings from the 500-book run

- EPUB navigation and media were reliable across the selected Gutenberg slice,
  including EPUB 2/3, NCX/nav, nested anchors, large single files, many-file
  books, SVG wrappers, `srcset`, objects, data images, and CSS backgrounds. The
  sole EPUB failure is publisher-build damage: *Three Blind Mice* references
  three absolute `file:///` image paths whose assets are not present in the ZIP.
- A generated 565-document, 4.55-million-word dictionary exposed a runtime
  coupling issue rather than a content heuristic issue. Lazy-loading PDF.js only
  for PDF workers reduced the complete EPUB worker below the 30-second ceiling.
- Office/InDesign PDFs may expose implementation bookmarks (`_Hlk...`,
  `OLE_LINK...`, `_Toc...`) or a lone junk bookmark such as `RH`. Destination
  resolution alone is not enough evidence. The parser now prefers a
  well-spread, prominent numbered-heading sequence and deduplicates body-sized
  TOC copies from real openers; credible multi-entry outlines still win.
- Some otherwise ordinary books contain full-page tables whose text operators
  are quarter-turned inside an unrotated portrait page. A conservative
  character-weighted detector normalizes only dominant LTR/RTL +/-90-degree
  pages and keeps row-major order; mixed/true vertical text remains strict.
- A PDF can contain one selectable publisher page and hundreds of scanned body
  pages. The acquisition manifest now persists text-page/word/character scope
  evidence, excludes such OCR-dependent files, and selects deterministic legal
  replacements without hiding parser errors that merely time out during scope
  screening.
- The only final PDF failure is a mathematical book whose broken font mapping
  yields 1,734 control glyphs in formulas and bullets. Retaining a strict
  failure is preferable to silently corrupting TTS and speed-reading text.

PDF image masks and form-contained graphics remain a later research area: the
current operator-list approach deliberately avoids promoting tiny masks and
decorative resources, but a future decoder should validate uncommon
illustration containers without eagerly materializing every bitmap.
