import { describe, expect, it } from "bun:test";
import { importPhaseLabel, isActiveImportStatus } from "./importPhaseLabel";

describe("importPhaseLabel", () => {
  it("maps active processing statuses to readable labels", () => {
    expect(importPhaseLabel("validating")).toBe("Processing");
    expect(importPhaseLabel("building_chapters")).toBe("Building chapters");
    expect(importPhaseLabel("extracting_text")).toBe("Extracting text");
    expect(isActiveImportStatus("queued")).toBe(true);
    expect(isActiveImportStatus("validating")).toBe(true);
    expect(isActiveImportStatus("completed")).toBe(false);
  });
});
