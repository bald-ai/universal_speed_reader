import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { TtsHighlightStyle } from "@/types/reading";
import { TTS_RATE_DEFAULT, WPM_DEFAULT } from "@/lib/constants";
import { getBookRepository } from "@/lib/storage/appRepository";

type Theme = "light" | "dark";

export type Settings = {
  wpm: number;
  ttsPlaybackRate: number;
  ttsVoiceIndex: number;
  ttsLanguage: string;
  ttsHighlightStyle: TtsHighlightStyle;
  fontSize: "small" | "medium" | "large" | "xl";
  fontFamily: "serif" | "sans-serif" | "monospace";
  theme: Theme;
  orpHighlight: boolean;
  orpHighlightColor: string;
};

type SettingsContextValue = {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
};

const DEFAULT_SETTINGS: Settings = {
  wpm: WPM_DEFAULT,
  ttsPlaybackRate: TTS_RATE_DEFAULT,
  ttsVoiceIndex: -1,
  ttsLanguage: "en-US",
  ttsHighlightStyle: "word",
  fontSize: "medium",
  fontFamily: "serif",
  theme: "dark",
  orpHighlight: true,
  orpHighlightColor: "#10b981",
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);
const SETTINGS_KEY = "settings.v1";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeSettings(raw: unknown): Partial<Settings> {
  if (!isObject(raw)) return {};
  const out: Partial<Settings> = {};

  if (typeof raw.wpm === "number" && Number.isFinite(raw.wpm)) out.wpm = raw.wpm;
  if (typeof raw.ttsPlaybackRate === "number" && Number.isFinite(raw.ttsPlaybackRate)) {
    out.ttsPlaybackRate = raw.ttsPlaybackRate;
  }
  if (typeof raw.ttsVoiceIndex === "number" && Number.isFinite(raw.ttsVoiceIndex)) {
    out.ttsVoiceIndex = raw.ttsVoiceIndex;
  }
  if (typeof raw.ttsLanguage === "string") out.ttsLanguage = raw.ttsLanguage;

  const highlightStyle = raw.ttsHighlightStyle;
  if (
    highlightStyle === "word" ||
    highlightStyle === "sentence" ||
    highlightStyle === "dim-rest" ||
    highlightStyle === "underline" ||
    highlightStyle === "karaoke" ||
    highlightStyle === "phrase"
  ) {
    out.ttsHighlightStyle = highlightStyle;
  }

  if (raw.fontSize === "small" || raw.fontSize === "medium" || raw.fontSize === "large" || raw.fontSize === "xl") {
    out.fontSize = raw.fontSize;
  }
  if (
    raw.fontFamily === "serif" ||
    raw.fontFamily === "sans-serif" ||
    raw.fontFamily === "monospace"
  ) {
    out.fontFamily = raw.fontFamily;
  }
  if (raw.theme === "light" || raw.theme === "dark") out.theme = raw.theme;
  if (typeof raw.orpHighlight === "boolean") out.orpHighlight = raw.orpHighlight;
  if (typeof raw.orpHighlightColor === "string") out.orpHighlightColor = raw.orpHighlightColor;

  return out;
}

export function SettingsProvider(props: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isHydrated, setIsHydrated] = useState(false);
  const persistTimeoutRef = useRef<number | null>(null);
  const latestSettingsRef = useRef<Settings>(DEFAULT_SETTINGS);

  const persistSettings = useCallback(async (next: Settings) => {
    try {
      const repo = await getBookRepository();
      await repo.putAppSetting(SETTINGS_KEY, next);
    } catch (error) {
      console.warn("Failed to persist settings:", error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const repo = await getBookRepository();
        const saved = await repo.getAppSetting<unknown>(SETTINGS_KEY);
        if (!cancelled && saved !== null) {
          const safe = sanitizeSettings(saved);
          setSettings((prev) => ({
            ...prev,
            ...safe,
          }));
        }
      } catch (error) {
        console.warn("Failed to load saved settings:", error);
      } finally {
        if (!cancelled) {
          setIsHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = window.document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [settings.theme]);

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isHydrated) return;
    if (persistTimeoutRef.current !== null) {
      window.clearTimeout(persistTimeoutRef.current);
    }

    persistTimeoutRef.current = window.setTimeout(() => {
      void persistSettings(settings);
    }, 120);

    return () => {
      if (persistTimeoutRef.current !== null) {
        window.clearTimeout(persistTimeoutRef.current);
        persistTimeoutRef.current = null;
      }
    };
  }, [isHydrated, persistSettings, settings]);

  useEffect(() => {
    return () => {
      if (typeof window === "undefined") return;
      if (!isHydrated) return;
      if (persistTimeoutRef.current !== null) {
        window.clearTimeout(persistTimeoutRef.current);
        persistTimeoutRef.current = null;
      }
      void persistSettings(latestSettingsRef.current);
    };
  }, [isHydrated, persistSettings]);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    setSettings((prev) => ({
      ...prev,
      ...partial,
    }));
  }, []);

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
    }),
    [settings, updateSettings]
  );

  return (
    <SettingsContext.Provider value={value}>
      {props.children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
