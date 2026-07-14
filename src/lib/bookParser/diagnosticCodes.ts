/** Stable parser/import diagnostic codes. Prefer these over message text. */
export const DiagnosticCode = {
  // Soft (import completes with warnings)
  cover_missing: "cover_missing",
  cover_inline_payload: "cover_inline_payload",
  images_invalid: "images_invalid",
  images_inline_payload: "images_inline_payload",
  images_undeclared: "images_undeclared",
  weak_chapters: "weak_chapters",
  garbled_text: "garbled_text",
  ornament_junk: "ornament_junk",
  picture_heavy: "picture_heavy",
  empty_paragraphs: "empty_paragraphs",

  // Hard (import must not complete)
  unusable_text: "unusable_text",
  collapsed_paragraphs: "collapsed_paragraphs",
  bad_paragraph_ids: "bad_paragraph_ids",
  scene_break_density: "scene_break_density",
  timeout: "timeout",
  totals_mismatch: "totals_mismatch",
  timing_invalid: "timing_invalid",
  other_failure: "other_failure",
} as const;

export type DiagnosticCodeName = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];

export const SOFT_DIAGNOSTIC_CODES = new Set<string>([
  DiagnosticCode.cover_missing,
  DiagnosticCode.cover_inline_payload,
  DiagnosticCode.images_invalid,
  DiagnosticCode.images_inline_payload,
  DiagnosticCode.images_undeclared,
  DiagnosticCode.weak_chapters,
  DiagnosticCode.garbled_text,
  DiagnosticCode.ornament_junk,
  DiagnosticCode.picture_heavy,
  DiagnosticCode.empty_paragraphs,
]);
