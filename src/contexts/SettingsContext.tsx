import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { TtsHighlightStyle } from "@/types/reading";
import { TTS_RATE_DEFAULT, WPM_DEFAULT } from "@/lib/constants";

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

export function SettingsProvider(props: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = window.document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [settings.theme]);

  const updateSettings = (partial: Partial<Settings>) => {
    setSettings((prev) => ({
      ...prev,
      ...partial,
    }));
  };

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSettings,
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
