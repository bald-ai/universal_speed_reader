
import { motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";
import { useSettings } from "@/contexts/SettingsContext";
import { PROGRESS_BAR_THEMES } from "@/contexts/SettingsContext";

type ProgressBarProps = {
  value: number;
  className?: string;
};

export default function ProgressBar(props: ProgressBarProps) {
  const { value, className = "" } = props;
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const { settings } = useSettings();
  const shouldReduceMotion = useReducedMotion();

  const theme = useMemo(
    () => PROGRESS_BAR_THEMES.find((t) => t.name === settings.progressBarTheme) ?? PROGRESS_BAR_THEMES[0],
    [settings.progressBarTheme]
  );

  return (
    <div className={`relative w-full h-2 rounded-full bg-neutral-800 overflow-hidden ${className}`}>
      <motion.div
        className="absolute top-0 left-0 h-full rounded-full"
        style={{
          background: `linear-gradient(to right, ${theme.from}, ${theme.via}, ${theme.to})`,
        }}
        initial={shouldReduceMotion ? false : { width: 0 }}
        animate={{ width: `${clamped}%` }}
        transition={{ duration: shouldReduceMotion ? 0 : 0.3, ease: "easeOut" }}
      />
      {/* Glow effect at leading edge */}
      {clamped > 0 && (
        <motion.div
          className="absolute top-0 h-full w-4 rounded-full blur-sm"
          style={{
            left: `calc(${clamped}% - 8px)`,
            backgroundColor: `${theme.glow}80`,
          }}
          initial={shouldReduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: shouldReduceMotion ? 0 : 0.3 }}
        />
      )}
    </div>
  );
}
