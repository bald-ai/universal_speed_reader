import { useState, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

type DisclosureProps = {
  label: string;
  summary: ReactNode;
  accentColor?: string;
  children: ReactNode;
};

export default function Disclosure(props: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const accent = props.accentColor ?? "#a78bfa";

  return (
    <div
      className="rounded-2xl border transition-colors duration-300"
      style={{
        borderColor: open ? `${accent}40` : "rgba(255,255,255,0.06)",
        background: open
          ? `linear-gradient(180deg, ${accent}08 0%, transparent 40%)`
          : "transparent",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
      >
        <motion.div
          animate={{ rotate: open ? 90 : 0 }}
          transition={shouldReduceMotion
            ? { duration: 0 }
            : { type: "spring", stiffness: 300, damping: 25 }}
          className="flex h-5 w-5 shrink-0 items-center justify-center"
        >
          <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
            <path
              d="M1 1L6 6L1 11"
              stroke={accent}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </motion.div>
        <span className="text-sm font-semibold text-neutral-100">{props.label}</span>
        <div className="ml-auto">{props.summary}</div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={shouldReduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={shouldReduceMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 280, damping: 28 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 space-y-5">{props.children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
