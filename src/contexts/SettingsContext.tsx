import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { devStoreGet, devStoreSet } from "@/lib/devStore";

type Theme = "light" | "dark";

export type Settings = {
  wpm: number;
  ttsPlaybackRate: number;
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
  wpm: 250,
  ttsPlaybackRate: 1.0,
  fontSize: "medium",
  fontFamily: "serif",
  theme: "dark",
  orpHighlight: true,
  orpHighlightColor: "#10b981",
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function SettingsProvider(props: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const loaded = useRef(false);

  // Load settings from devStore on mount
  useEffect(() => {
    let cancelled = false;
    devStoreGet<Partial<Settings>>("speedreader-settings").then((stored) => {
      if (cancelled) return;
      loaded.current = true;
      if (stored) {
        setSettings((prev) => ({ ...prev, ...stored }));
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Persist settings and apply theme class
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Only persist after initial load from devStore to avoid overwriting with defaults
    if (loaded.current) {
      devStoreSet("speedreader-settings", settings);
    }

    const root = window.document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [settings.wpm, settings.ttsPlaybackRate, settings.fontSize, settings.fontFamily, settings.theme, settings.orpHighlight, settings.orpHighlightColor]);

  const updateSettings = (partial: Partial<Settings>) => {
    setSettings((prev) => ({
      ...prev,
      ...partial
    }));
  };

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSettings
      }}
    >
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
