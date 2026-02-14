import { motion } from "framer-motion";

const BOOK_ICON = (
  <svg
    className="w-8 h-8"
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
  genre?: string;
  description?: string;
  coverUrl?: string;
  isMock?: boolean;
  readLabel?: string;
  readDisabled?: boolean;
  progress: number;
  onRead: () => void;
  tts: {
    available: boolean;
  };
  index?: number;
};

export default function BookCard(props: BookCardProps) {
  const {
    title,
    author,
    genre,
    description,
    coverUrl,
    isMock,
    readLabel,
    readDisabled,
    progress,
    onRead,
    tts,
    index = 0,
  } = props;
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));

  const coverTheme = (() => {
    const g = (genre ?? "").toLowerCase();
    if (g === "romance") {
      return {
        bg: "from-rose-500/20 to-pink-500/20",
        border: "border-rose-500/25",
        icon: "text-rose-300/70",
        chip: "border-rose-500/30 bg-rose-500/10 text-rose-200",
      };
    }
    if (g === "science") {
      return {
        bg: "from-sky-500/20 to-emerald-500/20",
        border: "border-sky-500/25",
        icon: "text-sky-300/70",
        chip: "border-sky-500/30 bg-sky-500/10 text-sky-200",
      };
    }
    if (g === "fantasy") {
      return {
        bg: "from-amber-500/20 to-fuchsia-500/20",
        border: "border-amber-500/25",
        icon: "text-amber-300/70",
        chip: "border-amber-500/30 bg-amber-500/10 text-amber-200",
      };
    }
    if (g === "casual nonfiction") {
      return {
        bg: "from-lime-500/20 to-teal-500/20",
        border: "border-lime-500/25",
        icon: "text-lime-300/70",
        chip: "border-lime-500/30 bg-lime-500/10 text-lime-200",
      };
    }
    return {
      bg: "from-violet-600/20 to-cyan-600/20",
      border: "border-violet-500/20",
      icon: "text-violet-400/60",
      chip: "border-violet-500/30 bg-violet-500/10 text-violet-200",
    };
  })();

  return (
    <motion.div
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
      className="w-full rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900/95 to-neutral-800/90 
        p-5 text-left shadow-lg shadow-black/40 
        hover:border-violet-500/40 hover:shadow-violet-500/10 
        transition-colors duration-200"
    >
      <div className="flex items-start gap-4">
        <div
          className={`h-20 w-14 shrink-0 rounded-lg bg-gradient-to-br ${coverTheme.bg} 
          border ${coverTheme.border} flex items-center justify-center overflow-hidden`}
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className={coverTheme.icon}>{BOOK_ICON}</div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-neutral-100 truncate">{title}</h2>
            {isMock ? (
              <span className="shrink-0 rounded-full border border-neutral-700 bg-neutral-900/60 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-neutral-300">
                MOCK
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-sm text-neutral-400">{author}</p>
            {genre ? (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wider ${coverTheme.chip}`}
              >
                {genre}
              </span>
            ) : null}
          </div>

          {description ? (
            <p className="mt-2 text-sm text-neutral-400 leading-snug line-clamp-2">
              {description}
            </p>
          ) : null}

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

          <div className="mt-5 flex items-center gap-2">
            <button
              type="button"
              onClick={onRead}
              disabled={!!readDisabled}
              className="flex-1 rounded-xl bg-neutral-100 text-neutral-900 text-sm font-semibold px-4 py-2
                hover:bg-white transition-colors duration-150 disabled:bg-neutral-800 disabled:text-neutral-400 disabled:hover:bg-neutral-800 disabled:cursor-not-allowed"
            >
              {readLabel ?? "Read"}
            </button>

            <div
              className={`rounded-xl border px-4 py-2 text-sm ${
                tts.available
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-neutral-700 bg-neutral-900/40 text-neutral-500"
              }`}
            >
              {tts.available ? "TTS Ready" : "TTS Unavailable"}
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
