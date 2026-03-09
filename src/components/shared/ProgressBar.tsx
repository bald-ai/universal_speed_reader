
import { motion } from "framer-motion";

type ProgressBarProps = {
  value: number;
  className?: string;
};

export default function ProgressBar(props: ProgressBarProps) {
  const { value, className = "" } = props;
  const clamped = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className={`relative w-full h-2 rounded-full bg-neutral-800 overflow-hidden ${className}`}>
      <motion.div
        className="absolute top-0 left-0 h-full rounded-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400"
        initial={{ width: 0 }}
        animate={{ width: `${clamped}%` }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
      {/* Glow effect at leading edge */}
      {clamped > 0 && (
        <motion.div
          className="absolute top-0 h-full w-4 rounded-full bg-cyan-400/50 blur-sm"
          style={{ left: `calc(${clamped}% - 8px)` }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3 }}
        />
      )}
    </div>
  );
}
