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
import type { BookRepository } from "@/lib/storage/bookRepository";

type Theme = "light" | "dark";

export type ProgressBarTheme =
  | "cotton-candy"
  | "playful-duo"
  | "toybox-adventure"
  | "warm-mischief"
  | "friendly-rivalry"
  | "candy-coop";

export type ProgressBarThemeConfig = {
  name: ProgressBarTheme;
  label: string;
  from: string;
  via: string;
  to: string;
  glow: string;
};

export const PROGRESS_BAR_THEMES: ProgressBarThemeConfig[] = [
  { name: "cotton-candy", label: "Cotton Candy", from: "#8b5cf6", via: "#22d3ee", to: "#34d399", glow: "#22d3ee" },
  { name: "playful-duo", label: "Playful Duo", from: "#FB7185", via: "#f9a8d4", to: "#22C55E", glow: "#FB7185" },
  { name: "toybox-adventure", label: "Toybox Adventure", from: "#A855F7", via: "#e879f9", to: "#FACC15", glow: "#FACC15" },
  { name: "warm-mischief", label: "Warm Mischief", from: "#F97316", via: "#fbbf24", to: "#0EA5E9", glow: "#F97316" },
  { name: "friendly-rivalry", label: "Friendly Rivalry", from: "#2563EB", via: "#818cf8", to: "#FB7185", glow: "#818cf8" },
  { name: "candy-coop", label: "Candy Co-op", from: "#EC4899", via: "#f0abfc", to: "#22D3EE", glow: "#EC4899" },
];

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
  progressBarTheme: ProgressBarTheme;
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
  progressBarTheme: "cotton-candy",
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

  if (typeof raw.progressBarTheme === "string" && PROGRESS_BAR_THEMES.some((t) => t.name === raw.progressBarTheme)) {
    out.progressBarTheme = raw.progressBarTheme as ProgressBarTheme;
  }

  return out;
}

function applyThemeClass(theme: Theme, root: { classList: Pick<DOMTokenList, "add" | "remove"> }): void {
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

async function loadSettingsFromRepository(
  repository: Pick<BookRepository, "getAppSetting">
): Promise<Partial<Settings>> {
  try {
    const saved = await repository.getAppSetting<unknown>(SETTINGS_KEY);
    if (saved === null) return {};
    return sanitizeSettings(saved);
  } catch (error) {
    console.warn("Failed to load saved settings:", error);
    return {};
  }
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
        const safe = await loadSettingsFromRepository(repo);
        if (!cancelled) {
          setSettings((prev) => ({
            ...prev,
            ...safe,
          }));
        }
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
    applyThemeClass(settings.theme, root);
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

export const __settingsContextInternals = {
  sanitizeSettings,
  applyThemeClass,
  loadSettingsFromRepository,
};
