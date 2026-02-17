import { describe, expect, it } from "bun:test";
import { resolveReadingStateFromProgress } from "@/contexts/ReadingContext";

describe("resolveReadingStateFromProgress", () => {
  it("returns default state when there are no paragraphs", () => {
    const resolved = resolveReadingStateFromProgress([], null);
    expect(resolved.mode).toBe("normal");
    expect(resolved.position).toEqual({ paragraphId: 0, wordIndex: 0 });
  });

  it("falls back to first paragraph when no saved progress exists", () => {
    const resolved = resolveReadingStateFromProgress([10, 11, 12], null);
    expect(resolved.mode).toBe("normal");
    expect(resolved.position).toEqual({ paragraphId: 10, wordIndex: 0 });
  });

  it("restores saved mode and position when paragraph exists", () => {
    const resolved = resolveReadingStateFromProgress([1, 2, 3], {
      paragraph_id: 2,
      word_index: 5,
      mode: "speed",
    });
    expect(resolved.mode).toBe("speed");
    expect(resolved.position).toEqual({ paragraphId: 2, wordIndex: 5 });
  });

  it("keeps mode but falls back to first paragraph when saved paragraph is missing", () => {
    const resolved = resolveReadingStateFromProgress([20, 30], {
      paragraph_id: 99,
      word_index: 2,
      mode: "speed",
    });
    expect(resolved.mode).toBe("speed");
    expect(resolved.position).toEqual({ paragraphId: 20, wordIndex: 0 });
  });
});
