import { motion } from "framer-motion";

type SpeedReaderWpmControlsProps = {
  wpm: number;
  isPaused: boolean;
  onDecrease: () => void;
  onIncrease: () => void;
  onPause: () => void;
  onResume: () => void;
};

export default function SpeedReaderWpmControls({
  wpm,
  isPaused,
  onDecrease,
  onIncrease,
  onPause,
  onResume,
}: SpeedReaderWpmControlsProps) {
  const speedButtons = (
    <>
      <button
        type="button"
        aria-label="Decrease speed"
        data-testid="speed-reader-wpm-down"
        onClick={onDecrease}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/6 text-sm font-medium text-neutral-400 transition-colors hover:border-amber-300/35 hover:bg-amber-300/15 hover:text-amber-200"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
        </svg>
      </button>
      <motion.span
        key={wpm}
        initial={{ scale: 1.2, color: "#fcd34d" }}
        animate={{ scale: 1, color: "#e5e7eb" }}
        transition={{ duration: 0.24 }}
        className="min-w-[46px] text-center text-xs font-semibold tabular-nums"
      >
        {wpm}
      </motion.span>
      <button
        type="button"
        aria-label="Increase speed"
        data-testid="speed-reader-wpm-up"
        onClick={onIncrease}
        className="flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-white/6 text-sm font-medium text-neutral-400 transition-colors hover:border-amber-300/35 hover:bg-amber-300/15 hover:text-amber-200"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
      </button>
    </>
  );

  if (!isPaused) {
    return (
      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-950/85 px-2 py-1 shadow-[0_8px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
        {speedButtons}
        <button
          type="button"
          aria-label="Pause speed reader"
          onClick={onPause}
          className="ml-1 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-neutral-950 shadow-[0_2px_12px_rgba(245,158,11,0.35)] transition-transform hover:scale-105 active:scale-95"
        >
          <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-950/85 px-2 py-1 shadow-[0_8px_40px_rgba(0,0,0,0.6)] backdrop-blur-xl">
      {speedButtons}
      <button
        type="button"
        aria-label="Resume speed reader"
        onClick={onResume}
        className="ml-1 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-neutral-950 shadow-[0_2px_12px_rgba(245,158,11,0.35)] transition-transform hover:scale-105 active:scale-95"
      >
        <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
          <path d="M8 5.14v13.72a1 1 0 001.5.86l11-6.86a1 1 0 000-1.72l-11-6.86A1 1 0 008 5.14z" />
        </svg>
      </button>
    </div>
  );
}
