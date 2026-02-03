import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

export type Settings = {
  wpm: number;
  fontSize: "small" | "medium" | "large" | "xl";
  fontFamily: "serif" | "sans-serif" | "monospace";
  theme: Theme;
};

type SettingsContextValue = {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
};

const DEFAULT_SETTINGS: Settings = {
  wpm: 250,
  fontSize: "medium",
  fontFamily: "serif",
  theme: "dark"
};

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

function getInitialSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;

  try {
    const raw = window.localStorage.getItem("speedreader:settings");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch {
    // ignore malformed settings
  }

  // Fallback to system preference for theme
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  if (prefersDark) {
    return { ...DEFAULT_SETTINGS, theme: "dark" };
  }

  return DEFAULT_SETTINGS;
}

export function SettingsProvider(props: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(getInitialSettings);

  // Persist settings and apply theme class
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("speedreader:settings", JSON.stringify(settings));
    } catch {
      // ignore quota errors for MVP
    }

    const root = window.document.documentElement;
    if (settings.theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [settings.wpm, settings.fontSize, settings.fontFamily, settings.theme]);

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