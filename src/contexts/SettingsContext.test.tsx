import { describe, expect, it } from "bun:test";
import { __settingsContextInternals } from "@/contexts/SettingsContext";
import type { BookRepository } from "@/lib/storage/bookRepository";

function makeClassList() {
  const values = new Set<string>();

  return {
    values,
    classList: {
      add(token: string) {
        values.add(token);
      },
      remove(token: string) {
        values.delete(token);
      },
    },
  };
}

function makeRepository(
  implementation: () => Promise<unknown>
): Pick<BookRepository, "getAppSetting"> {
  return {
    async getAppSetting<T>(_key: string) {
      return (await implementation()) as T | null;
    },
  };
}

describe("SettingsContext internals", () => {
  it("sanitizes persisted settings and ignores invalid values", () => {
    const out = __settingsContextInternals.sanitizeSettings({
      theme: "light",
      fontSize: "xl",
      fontFamily: "invalid-font",
      wpm: 420,
      ttsPlaybackRate: "too-fast",
      ttsVoiceIndex: 4,
      ttsLanguage: "cs-CZ",
      ttsHighlightStyle: "karaoke",
      orpHighlight: false,
      orpHighlightColor: "#ff6600",
    });

    expect(out).toEqual({
      theme: "light",
      fontSize: "xl",
      wpm: 420,
      ttsVoiceIndex: 4,
      ttsLanguage: "cs-CZ",
      ttsHighlightStyle: "karaoke",
      orpHighlight: false,
      orpHighlightColor: "#ff6600",
    });
  });

  it("loads and sanitizes settings from the repository", async () => {
    const out = await __settingsContextInternals.loadSettingsFromRepository(
      makeRepository(async () => ({
        theme: "light",
        fontFamily: "sans-serif",
        ttsPlaybackRate: 1.25,
        junk: "ignore-me",
      }))
    );

    expect(out).toEqual({
      theme: "light",
      fontFamily: "sans-serif",
      ttsPlaybackRate: 1.25,
    });
  });

  it("returns an empty patch when there are no saved settings", async () => {
    const out = await __settingsContextInternals.loadSettingsFromRepository(
      makeRepository(async () => null)
    );

    expect(out).toEqual({});
  });

  it("returns an empty patch when loading settings fails", async () => {
    const out = await __settingsContextInternals.loadSettingsFromRepository(
      makeRepository(async () => {
        throw new Error("storage offline");
      })
    );

    expect(out).toEqual({});
  });

  it("adds or removes the dark class based on theme", () => {
    const root = makeClassList();

    __settingsContextInternals.applyThemeClass("dark", root);
    expect(root.values.has("dark")).toBe(true);

    __settingsContextInternals.applyThemeClass("light", root);
    expect(root.values.has("dark")).toBe(false);
  });
});
