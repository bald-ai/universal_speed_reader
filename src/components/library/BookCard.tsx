import { motion } from "framer-motion";
import type { MouseEventHandler } from "react";

const BOOK_ICON = (
  <svg
    className="w-8 h-8 text-violet-400/60"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
    />
  </svg>
);

type BookCardProps = {
  title: string;
  author: string;
  progress: number;
  onClick: MouseEventHandler<HTMLButtonElement>;
  index?: number;
};

export default function BookCard(props: BookCardProps) {
  const { title, author, progress, onClick, index = 0 } = props;
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ 
        duration: 0.4, 
        delay: index * 0.1,
        ease: [0.25, 0.46, 0.45, 0.94]
      }}
      whileHover={{ 
        y: -4, 
        transition: { duration: 0.2, ease: "easeOut" }
      }}
      whileTap={{ scale: 0.98 }}
      className="w-full rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900/95 to-neutral-800/90 
        p-5 text-left shadow-lg shadow-black/40 
        hover:border-violet-500/40 hover:shadow-violet-500/10 
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 
        focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 transition-colors duration-200"
    >
      <div className="flex items-start gap-4">
        <div className="h-20 w-14 shrink-0 rounded-lg bg-gradient-to-br from-violet-600/20 to-cyan-600/20 
          border border-violet-500/20 flex items-center justify-center overflow-hidden">
          {BOOK_ICON}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-neutral-100 truncate">{title}</h2>
          <p className="text-sm text-neutral-400 mt-1">{author}</p>
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-neutral-400 mb-2">
              <span className="uppercase tracking-wider text-[10px]">Progress</span>
              <span className="font-medium text-neutral-300">{clampedProgress}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400"
                initial={{ width: 0 }}
                animate={{ width: `${clampedProgress}%` }}
                transition={{ duration: 0.8, delay: index * 0.1 + 0.2, ease: "easeOut" }}
              />
            </div>
          </div>
        </div>
      </div>
    </motion.button>
  );
}
