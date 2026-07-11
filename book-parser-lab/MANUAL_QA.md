# Book Parser Lab — Manual Spot Checks

Manual review complements, but does not replace, the all-book automatic checks.
The final corpus rows are added after evaluation; this file records concrete
evidence rather than a generic checklist.

## Reference and pre-corpus checks

| Book / case | Evidence inspected | Result |
|---|---|---|
| Pride and Prejudice golden EPUB | Supplied chapter-menu, front-matter, colophon, illustration, and library-cover screenshots; generated `results/latest/spot-checks/pride-and-prejudice.html`; directly viewed the extracted cover, colophon, “Reading Jane’s Letters,” Chapter I heading, and next illustration assets; inspected chapter/image paragraph anchors | **PASS.** 2,515 sequential paragraphs, 130,142 app-token words, 63 navigation entries, 163 monotonic image sidecars, separate cover, no diagnostics, ~0.44 s. Front matter remains; the supplied descriptive TOC labels remain; colophon and Jane illustration occur in the accepted order; Chapter I starts at paragraph 251. |
| Early Algebra open-access PDF | Rendered source page 10 with Poppler and viewed the PNG; generated `results/latest/spot-checks/early-algebra.html`; compared extracted chapter/section starts, prose, footer filtering, and image pointers | **PASS.** 48 text pages, 38 outline/heading entries, selectable prose reconstructed in reading order, Chapter 2 and 2.1 mapped to their actual heading paragraphs, ©/DOI page furniture removed, five pointer images retained, no diagnostics, under 1 s parser time. |
| Same-baseline two-column PDF regression | Synthetic PDF plus emitted paragraph sequence | **PASS.** Full left column precedes full right column; spanning heading remains first; no interleaving false pass. |
| Reverse paint-order PDF image regression | Synthetic PDF with lower image painted before upper image | **PASS.** Sidecars emit in geometric/paragraph order while pointer image indices retain the source operator identity. |
| EPUB 2/3 media and structure regressions | Synthetic EPUB 3 nav/media taxonomy and EPUB 2 NCX/div-soup/SVG-wrapper fixtures | **PASS.** Nested anchors, non-linear spine behavior, unresolved-image strictness, SVG wrapper dereferencing, pointer media, NCX targets, and weak-TOC heading fallback behave as specified. |
| Adventures of Huckleberry Finn illustrated EPUB | Generated `results/latest/spot-checks/huckleberry-finn.html`; directly viewed the extracted frontispiece, Jim illustration, Chapter V illustrated page, and later chapter illustration; inspected their anchors and chapter starts | **PASS.** 2,635 paragraphs, 114,126 app-token words, 48 navigation entries, 177 monotonic sidecar images, separate cover, no diagnostics, ~0.27 s. Sample image anchors progress 287 → 302 → 383 → 784 while Chapter I/II starts remain 288/298. |

## Corpus spot checks

The definitive run is `results/final-500-caffeinated/`: 500 books, sequential
per-book timing, with Mac idle sleep suppressed so the 30-second ceiling measures
parser work rather than machine suspension.

| Book / case | Evidence inspected | Result |
|---|---|---|
| Prison, Architecture and Humans PDF | Rendered Contents page 10 and prose page 35 with Poppler; compared the source's Chapter/Part typography with final chapter starts and image pointers | **PASS.** 118,042 words, 2,522 paragraphs, 16 real chapters plus Parts I-III/front matter (21 entries total), 165 monotonic images, no diagnostics, 7.45 s. Internal links no longer become chapters and body prose beginning with "part" stays prose. |
| Advances in Research Using the C-SPAN Archives PDF | Rendered Foreword page 10 and Chapter 1 page 35; inspected the junk one-entry bookmark, final warning, and recovered starts | **PASS with warning.** 81,233 words, 1,741 paragraphs, 21 useful chapter/front-matter/appendix entries, 11 images, 2.68 s. The weak bookmark is explicitly replaced by the visible Chapters 1-11 sequence. |
| Putting a Face on It PDF | Rendered Contents page 10 and Chapter 2 page 35; compared TOC duplicates against higher-prominence real Part/Chapter openers | **PASS with warning.** 127,792 words, 2,157 paragraphs, Parts I-V and Chapters 1-15 plus front matter/appendices (24 entries), 91 images, 4.01 s. Junk `RH` outline is not trusted. |
| Ethics and Civil Drones PDF | Rendered ordinary prose page 35 and sideways table page 25; inspected normalized table rows, image identity/anchors, and residual orientation evidence | **PASS.** 22 full-page quarter-turned tables normalize conservatively. Final model: 28,276 words, 1,078 paragraphs, 56 entries, 24 images, no diagnostics, 1.11 s; only 86/8,083 items remain vertical versus 2,283 before the fix. |
| Webster's Unabridged Dictionary EPUB | Timed the isolated worker and inspected final corpus output | **PASS extreme-size case.** 4,545,507 words and 430,783 paragraphs across 565 content files; lazy format loading reduced end-to-end worker time below the ceiling (20.51 s in the definitive run). |
| Indefinite Pronouns PDF candidate | Rendered pages 2 and 100; ran the persisted PDF text-scope screen | **EXCLUDED / replaced, as required by scope.** Page 2 has selectable publisher text, but the body is page images: only 1/384 pages and 275 words are selectable. The manifest records the evidence and selected the in-scope replacement *Brexit and Beyond*. |
| Complete Version of ye Three Blind Mice EPUB | Opened the final failure preview and materialized illustration assets; inspected XHTML references and ZIP inventory for pages 8, 20, and 31 | **GENUINE FAIL -- Images missing.** Model text/navigation remains usable (3,979 words, 245 paragraphs, 8 entries, 52/55 images), but the EPUB contains absolute publisher-build `file:///.../page8.jpg`, `page20.jpg`, and `page31.png` references while those assets are absent from the archive. |
| Finite Difference Computing with Exponential Decay Models PDF | Rendered Contents page 10; inspected the final failure preview, extracted prose/equations, and decoded-character distribution | **GENUINE FAIL -- Unusable text fidelity.** All 210 pages have selectable text and the model has 72,245 words, 3,215 paragraphs, 42 entries, and 14 images, but the PDF font mapping emits 1,734 control glyphs (0.423% of 410,333 characters), including mathematical symbols/bullets. Strict failure protects TTS and speed-reading text fidelity. |

All other automatic failures found during the exploratory 250-book and first
500-book passes were reproduced and resolved before the definitive run; none
were relabeled or removed merely to improve the pass rate.
