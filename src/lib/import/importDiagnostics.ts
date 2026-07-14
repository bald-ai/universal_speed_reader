import { DiagnosticCode, SOFT_DIAGNOSTIC_CODES } from "@/lib/bookParser/diagnosticCodes";
import type { ParserDiagnostic } from "@/lib/bookParser/types";
import type { ProcessingWarning } from "@/types/storage";

export type ImportDiagnosticClassification = {
  /** First hard failure that should abort import. */
  hardFailure: ParserDiagnostic | null;
  /** Soft issues stored on a completed, openable book. */
  warnings: ProcessingWarning[];
};

/** Map stable diagnostic codes to library/Last-import warning codes + plain copy. */
const WARNING_BY_DIAGNOSTIC_CODE: Record<string, ProcessingWarning> = {
  [DiagnosticCode.images_invalid]: {
    code: "images_missing",
    message: "Some pictures are missing.",
  },
  [DiagnosticCode.images_inline_payload]: {
    code: "images_missing",
    message: "Some pictures are missing.",
  },
  [DiagnosticCode.images_undeclared]: {
    code: "images_missing",
    message: "Some pictures are missing.",
  },
  [DiagnosticCode.cover_missing]: {
    code: "cover_missing",
    message: "No cover image was found.",
  },
  [DiagnosticCode.cover_inline_payload]: {
    code: "cover_missing",
    message: "No cover image was found.",
  },
  [DiagnosticCode.weak_chapters]: {
    code: "weak_chapters",
    message: "Chapter list may be incomplete or unclear.",
  },
  [DiagnosticCode.garbled_text]: {
    code: "garbled_text",
    message: "Some text may sound wrong in speech or speed reading.",
  },
  [DiagnosticCode.ornament_junk]: {
    code: "ornament_junk",
    message: "Some decorative marks may appear as text.",
  },
  [DiagnosticCode.picture_heavy]: {
    code: "picture_heavy",
    message: "This book has little text relative to pictures.",
  },
  [DiagnosticCode.empty_paragraphs]: {
    code: "empty_paragraphs",
    message: "Some empty paragraphs were skipped or kept as blanks.",
  },
};

function resolveDiagnosticCode(diagnostic: ParserDiagnostic): string | null {
  if (diagnostic.code && diagnostic.code.trim().length > 0) {
    return diagnostic.code;
  }

  // Fallback for older/uncoded parser diagnostics.
  if (diagnostic.bucket === "Images missing / blank / badly placed") return DiagnosticCode.images_invalid;
  if (diagnostic.bucket === "Cover missing") return DiagnosticCode.cover_missing;
  if (diagnostic.bucket === "Weak / missing / nonsense chapters") return DiagnosticCode.weak_chapters;
  if (diagnostic.bucket === "Bad paragraph IDs") return DiagnosticCode.bad_paragraph_ids;
  if (diagnostic.bucket === "Timeout / extreme slowness") return DiagnosticCode.timeout;

  const normalized = diagnostic.message.toLowerCase();
  if (normalized.includes("decoding/control") || normalized.includes("replacement or private-use")) {
    return DiagnosticCode.garbled_text;
  }
  if (normalized.includes("ornament")) return DiagnosticCode.ornament_junk;
  if (normalized.includes("most pdf pages lack usable")) return DiagnosticCode.picture_heavy;
  if (normalized.includes("empty paragraphs")) return DiagnosticCode.empty_paragraphs;
  if (normalized.includes("only ") && normalized.includes("words")) return DiagnosticCode.unusable_text;
  if (normalized.includes("collapsed")) return DiagnosticCode.collapsed_paragraphs;
  if (normalized.includes("scene-boundary density")) return DiagnosticCode.scene_break_density;
  return null;
}

function isSoftDiagnostic(diagnostic: ParserDiagnostic): boolean {
  if (diagnostic.severity === "warning") return true;
  const code = resolveDiagnosticCode(diagnostic);
  if (code && SOFT_DIAGNOSTIC_CODES.has(code)) return true;
  return false;
}

function toProcessingWarning(diagnostic: ParserDiagnostic): ProcessingWarning {
  const code = resolveDiagnosticCode(diagnostic);
  if (code && WARNING_BY_DIAGNOSTIC_CODE[code]) {
    return WARNING_BY_DIAGNOSTIC_CODE[code];
  }
  return {
    code: code ?? "import_warning",
    message: diagnostic.message,
  };
}

/**
 * Soft-allows flawed-but-usable parser issues; hard-fails only when the book
 * is unreadable or the reading model would be unsafe.
 */
export function classifyImportDiagnostics(
  diagnostics: ParserDiagnostic[],
): ImportDiagnosticClassification {
  const warnings: ProcessingWarning[] = [];
  const seenCodes = new Set<string>();
  let hardFailure: ParserDiagnostic | null = null;

  for (const diagnostic of diagnostics) {
    if (isSoftDiagnostic(diagnostic)) {
      const warning = toProcessingWarning(diagnostic);
      if (seenCodes.has(warning.code)) continue;
      seenCodes.add(warning.code);
      warnings.push(warning);
      continue;
    }

    if (diagnostic.severity === "failure" && hardFailure === null) {
      hardFailure = diagnostic;
    }
  }

  return { hardFailure, warnings };
}

/** Ensure a missing-images warning is present after dropping bad image payloads. */
export function ensureImagesMissingWarning(warnings: ProcessingWarning[]): ProcessingWarning[] {
  if (warnings.some((warning) => warning.code === "images_missing")) return warnings;
  return [
    ...warnings,
    {
      code: "images_missing",
      message: "Some pictures are missing.",
    },
  ];
}
