import { describe, expect, test } from "bun:test";
import { DiagnosticCode } from "@/lib/bookParser/diagnosticCodes";
import { classifyImportDiagnostics } from "./importDiagnostics";
import type { ParserDiagnostic } from "@/lib/bookParser/types";

function failure(
  bucket: ParserDiagnostic["bucket"],
  message: string,
  code?: string,
): ParserDiagnostic {
  return { bucket, severity: "failure", message, ...(code ? { code } : {}) };
}

function warning(
  bucket: ParserDiagnostic["bucket"],
  message: string,
  code?: string,
): ParserDiagnostic {
  return { bucket, severity: "warning", message, ...(code ? { code } : {}) };
}

describe("classifyImportDiagnostics", () => {
  test("soft-allows coded image and garbled-text failures with plain messages", () => {
    const result = classifyImportDiagnostics([
      failure("Images missing / blank / badly placed", "3 images have invalid pointers", DiagnosticCode.images_invalid),
      failure("No / unusable text", "Extracted text contains too many decoding/control characters.", DiagnosticCode.garbled_text),
      warning("Cover missing", "No reasonable library cover was found.", DiagnosticCode.cover_missing),
    ]);

    expect(result.hardFailure).toBeNull();
    expect(result.warnings).toEqual([
      { code: "images_missing", message: "Some pictures are missing." },
      { code: "garbled_text", message: "Some text may sound wrong in speech or speed reading." },
      { code: "cover_missing", message: "No cover image was found." },
    ]);
  });

  test("soft-allows weak chapters, ornaments, and picture-heavy PDFs by code", () => {
    const result = classifyImportDiagnostics([
      failure("Weak / missing / nonsense chapters", "No chapter/navigation entry was extracted.", DiagnosticCode.weak_chapters),
      failure("No / unusable text", "25 isolated scene ornaments leaked into readable paragraphs.", DiagnosticCode.ornament_junk),
      failure("No / unusable text", "Most PDF pages lack usable selectable text", DiagnosticCode.picture_heavy),
    ]);

    expect(result.hardFailure).toBeNull();
    expect(result.warnings.map((entry) => entry.code)).toEqual([
      "weak_chapters",
      "ornament_junk",
      "picture_heavy",
    ]);
  });

  test("hard-fails almost no text, bad paragraph ids, and model integrity issues", () => {
    expect(classifyImportDiagnostics([
      failure("No / unusable text", "Only 12 words of usable text were extracted.", DiagnosticCode.unusable_text),
    ]).hardFailure?.code).toBe(DiagnosticCode.unusable_text);

    expect(classifyImportDiagnostics([
      failure("Bad paragraph IDs", "Paragraph index 0 has id 2", DiagnosticCode.bad_paragraph_ids),
    ]).hardFailure?.code).toBe(DiagnosticCode.bad_paragraph_ids);

    expect(classifyImportDiagnostics([
      failure("No / unusable text", "Paragraph boundaries collapsed", DiagnosticCode.collapsed_paragraphs),
    ]).hardFailure?.code).toBe(DiagnosticCode.collapsed_paragraphs);

    expect(classifyImportDiagnostics([
      failure("Timeout / extreme slowness", "Parsing took 45000 ms", DiagnosticCode.timeout),
    ]).hardFailure?.code).toBe(DiagnosticCode.timeout);

    expect(classifyImportDiagnostics([
      failure("Other", "Output totals do not match", DiagnosticCode.totals_mismatch),
    ]).hardFailure?.code).toBe(DiagnosticCode.totals_mismatch);
  });
});
