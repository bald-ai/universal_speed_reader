export const TTS_RATE_MIN = 1.0;
export const TTS_RATE_MAX = 3.0;
export const TTS_RATE_STEP = 0.1;
export const TTS_RATE_DEFAULT = 1.0;

export const WPM_MIN = 100;
export const WPM_MAX = 600;
export const WPM_STEP = 5;
export const WPM_DEFAULT = 250;

export function clampTtsPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return TTS_RATE_DEFAULT;
  return Math.max(TTS_RATE_MIN, Math.min(TTS_RATE_MAX, rate));
}

export function normalizeTtsPlaybackRate(rate: number): number {
  const stepped = Math.round(rate / TTS_RATE_STEP) * TTS_RATE_STEP;
  return Number(clampTtsPlaybackRate(stepped).toFixed(1));
}

export function clampWpm(wpm: number): number {
  if (!Number.isFinite(wpm)) return WPM_DEFAULT;
  return Math.max(WPM_MIN, Math.min(WPM_MAX, wpm));
}

export function normalizeWpm(wpm: number): number {
  const stepped = Math.round(wpm / WPM_STEP) * WPM_STEP;
  return Math.round(clampWpm(stepped));
}
