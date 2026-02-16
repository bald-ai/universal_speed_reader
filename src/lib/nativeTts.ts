import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { clampTtsPlaybackRate, TTS_RATE_DEFAULT } from "@/lib/constants";

type RangeStartInfo = {
  start: number;
  end: number;
  spokenWord: string;
};

export type NativeTtsQueueStrategy = "flush" | "add";

export type NativeTtsVoice = {
  voiceURI: string;
  name: string;
  lang: string;
  localService?: boolean;
  default?: boolean;
};

type PluginListenerHandle = {
  remove: () => Promise<void>;
};

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return TTS_RATE_DEFAULT;
  return clampTtsPlaybackRate(rate);
}

export async function isNativeTtsAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await TextToSpeech.getSupportedLanguages();
    return true;
  } catch {
    return false;
  }
}

export async function speakNativeText(options: {
  text: string;
  rate?: number;
  lang?: string;
  voice?: number;
  queueStrategy?: NativeTtsQueueStrategy;
}): Promise<void> {
  await TextToSpeech.speak({
    text: options.text,
    lang: options.lang ?? "en-US",
    rate: clampRate(options.rate ?? TTS_RATE_DEFAULT),
    pitch: 1,
    volume: 1,
    voice: typeof options.voice === "number" ? options.voice : -1,
    queueStrategy: options.queueStrategy === "add" ? 1 : 0,
  });
}

export async function getNativeTtsVoices(): Promise<NativeTtsVoice[]> {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    const result = await TextToSpeech.getSupportedVoices();
    return Array.isArray(result.voices) ? (result.voices as NativeTtsVoice[]) : [];
  } catch {
    return [];
  }
}

export async function stopNativeTts(): Promise<void> {
  try {
    await TextToSpeech.stop();
  } catch {
    // best effort
  }
}

export async function subscribeRangeStart(
  onRangeStart: (info: RangeStartInfo) => void
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};

  try {
    const handle = (await TextToSpeech.addListener(
      "onRangeStart",
      onRangeStart
    )) as unknown as PluginListenerHandle;
    return () => {
      handle.remove().catch(() => {});
    };
  } catch {
    return () => {};
  }
}
