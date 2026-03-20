import { motion } from "framer-motion";
import { clampWpm, WPM_MAX, WPM_MIN, WPM_STEP } from "@/lib/constants";

type SpeedReadingWpmSettingProps = {
  wpm: number;
  onChange: (wpm: number) => void;
};

export default function SpeedReadingWpmSetting({
  wpm,
  onChange,
}: SpeedReadingWpmSettingProps) {
  return (
    <section>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="font-medium text-neutral-200">Speed reading WPM</span>
        <motion.span
          key={wpm}
          initial={{ scale: 1.2, color: "#a78bfa" }}
          animate={{ scale: 1, color: "#a78bfa" }}
          className="text-xs font-medium text-violet-400"
        >
          {wpm} WPM
        </motion.span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={WPM_MIN}
          max={WPM_MAX}
          step={WPM_STEP}
          value={wpm}
          onChange={(event) => {
            const value = Number(event.target.value);
            onChange(clampWpm(value));
          }}
          className="w-full h-2 cursor-pointer appearance-none rounded-lg bg-neutral-800
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-violet-500
            [&::-webkit-slider-thumb]:shadow-lg
            [&::-webkit-slider-thumb]:shadow-violet-500/30
            [&::-webkit-slider-thumb]:transition-transform
            [&::-webkit-slider-thumb]:hover:scale-110
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:bg-violet-500
            [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:shadow-lg
            [&::-moz-range-thumb]:shadow-violet-500/30"
        />
        <div className="mt-2 flex justify-between text-xs text-neutral-500">
          <span>{WPM_MIN}</span>
          <span>{Math.round((WPM_MIN + WPM_MAX) / 2)}</span>
          <span>{WPM_MAX}</span>
        </div>
      </div>
    </section>
  );
}
