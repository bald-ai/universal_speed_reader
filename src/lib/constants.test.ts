import { describe, expect, it } from "bun:test";
import {
  clampTtsPlaybackRate,
  clampWpm,
  normalizeTtsPlaybackRate,
  normalizeWpm,
  TTS_RATE_DEFAULT,
  TTS_RATE_MAX,
  TTS_RATE_MIN,
  WPM_DEFAULT,
  WPM_MAX,
  WPM_MIN,
} from "./constants";

describe("shared speed constants helpers", () => {
  it("clamps TTS playback rate within configured bounds", () => {
    expect(clampTtsPlaybackRate(TTS_RATE_MIN - 1)).toBe(TTS_RATE_MIN);
    expect(clampTtsPlaybackRate(TTS_RATE_MAX + 1)).toBe(TTS_RATE_MAX);
    expect(clampTtsPlaybackRate(2.2)).toBe(2.2);
  });

  it("normalizes TTS rate to step and fallback defaults", () => {
    expect(normalizeTtsPlaybackRate(1.04)).toBe(1.0);
    expect(normalizeTtsPlaybackRate(1.06)).toBe(1.1);
    expect(normalizeTtsPlaybackRate(Number.NaN)).toBe(TTS_RATE_DEFAULT);
  });

  it("clamps WPM within configured bounds", () => {
    expect(clampWpm(WPM_MIN - 50)).toBe(WPM_MIN);
    expect(clampWpm(WPM_MAX + 50)).toBe(WPM_MAX);
    expect(clampWpm(310)).toBe(310);
  });

  it("normalizes WPM to step and default when non-finite", () => {
    expect(normalizeWpm(253)).toBe(255);
    expect(normalizeWpm(248)).toBe(250);
    expect(normalizeWpm(Number.POSITIVE_INFINITY)).toBe(WPM_DEFAULT);
  });
});
