import { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { getBookCoverPlaceholder } from "@/lib/library/coverPlaceholders";

type BookCardProps = {
  title: string;
  author: string;
  genre?: string;
  description?: string;
  coverUrl?: string;
  statusBadge?: string;
  readLabel?: string;
  readDisabled?: boolean;
  editLabel?: string;
  editDisabled?: boolean;
  deleteLabel?: string;
  deleteDisabled?: boolean;
  progress: number;
  folderColor?: string;
  onRead: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  index?: number;
};

export default function BookCard(props: BookCardProps) {
  const {
    title,
    author,
    coverUrl,
    statusBadge,
    readDisabled,
    editLabel,
    editDisabled,
    deleteLabel,
    deleteDisabled,
    progress,
    folderColor,
    onRead,
    onEdit,
    onDelete,
    index = 0,
  } = props;
  const shouldReduceMotion = useReducedMotion();
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const [showActions, setShowActions] = useState(false);

  useEffect(() => {
    setCoverLoadFailed(false);
  }, [coverUrl]);

  const resolvedCoverUrl = useMemo(() => {
    if (coverUrl && !coverLoadFailed) {
      return coverUrl;
    }
    return getBookCoverPlaceholder(clampedProgress);
  }, [clampedProgress, coverLoadFailed, coverUrl]);
  const isUsingPlaceholder = !coverUrl || coverLoadFailed;

  const coverBg = (() => {
    if (!isUsingPlaceholder) return "bg-neutral-800";
    const colorMap: Record<string, string> = {
      rose: "bg-gradient-to-br from-rose-500/30 to-pink-500/20",
      emerald: "bg-gradient-to-br from-emerald-500/30 to-teal-500/20",
      fuchsia: "bg-gradient-to-br from-fuchsia-500/30 to-violet-500/20",
      sky: "bg-gradient-to-br from-sky-500/30 to-cyan-500/20",
      violet: "bg-gradient-to-br from-violet-500/30 to-indigo-500/20",
      amber: "bg-gradient-to-br from-amber-500/30 to-orange-500/20",
      cyan: "bg-gradient-to-br from-cyan-500/30 to-teal-500/20",
      lime: "bg-gradient-to-br from-lime-500/30 to-green-500/20",
    };
    return folderColor && colorMap[folderColor] ? colorMap[folderColor] : "bg-neutral-800";
  })();

  return (
    <motion.div
      initial={shouldReduceMotion ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={shouldReduceMotion ? { duration: 0 } : {
        duration: 0.35,
        delay: index * 0.06,
        ease: [0.25, 0.46, 0.45, 0.94],
      }}
      className="group relative w-full rounded-2xl border border-neutral-800/60 bg-neutral-900/80
        overflow-hidden transition-colors duration-200 hover:border-neutral-700"
    >
      <div className="flex w-full items-center gap-4 p-4">
        {/* Cover — tappable to read */}
        <button
          type="button"
          onClick={onRead}
          disabled={!!readDisabled}
          className="shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className={`h-16 w-11 rounded-lg overflow-hidden ${coverBg} shadow-md shadow-black/30`}>
            <img
              src={resolvedCoverUrl}
              alt=""
              className={`h-full w-full ${isUsingPlaceholder ? "object-contain p-1.5 opacity-60" : "object-cover"}`}
              loading="lazy"
              decoding="async"
              onError={coverUrl && !coverLoadFailed ? () => setCoverLoadFailed(true) : undefined}
            />
          </div>
        </button>

        {/* Text block — tappable to read */}
        <button
          type="button"
          onClick={onRead}
          disabled={!!readDisabled}
          className="flex-1 min-w-0 text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-neutral-100 truncate leading-tight">
              {title}
            </h2>
          </div>
          <p className="mt-0.5 text-[13px] text-neutral-500 truncate">{author}</p>
          {statusBadge ? (
            <span className="mt-1 inline-block rounded-full bg-neutral-800/80 px-2 py-0.5 text-[10px] font-medium tracking-wide text-neutral-400">
              {statusBadge}
            </span>
          ) : null}
        </button>

        {/* Right side: progress + actions */}
        <div className="shrink-0 flex items-center gap-3">
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <div className="h-1 w-14 rounded-full bg-neutral-800 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400"
                  initial={shouldReduceMotion ? false : { width: 0 }}
                  animate={{ width: `${clampedProgress}%` }}
                  transition={shouldReduceMotion
                    ? { duration: 0 }
                    : { duration: 0.6, delay: index * 0.06 + 0.15, ease: "easeOut" }}
                />
              </div>
              <span className="text-[11px] font-medium text-neutral-500 tabular-nums w-7 text-right">
                {clampedProgress}%
              </span>
            </div>
          </div>

          {(onEdit || onDelete) ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowActions((v) => !v);
              }}
              className="flex items-center justify-center h-9 w-9 -mr-1 rounded-xl text-neutral-500
                hover:text-neutral-300 hover:bg-neutral-800 active:bg-neutral-700
                transition-colors"
              aria-label="More actions"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="4" r="1.5" fill="currentColor" />
                <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                <circle cx="9" cy="14" r="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {/* Expanded actions panel */}
      {showActions && (onEdit || onDelete) ? (
        <div className="flex items-center gap-2 px-4 pb-3 border-t border-neutral-800/40 pt-3">

          <button
            type="button"
            onClick={() => setShowActions(false)}
            className="text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors mr-auto"
          >
            Close
          </button>
          {onEdit ? (
            <button
              type="button"
              onClick={onEdit}
              disabled={!!editDisabled}
              className="rounded-lg border border-neutral-700/60 bg-neutral-800/60 px-3 py-1.5 text-xs font-medium text-neutral-300
                hover:bg-neutral-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {editLabel ?? "Edit"}
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={!!deleteDisabled}
              className="rounded-lg border border-red-500/20 bg-red-500/8 px-3 py-1.5 text-xs font-medium text-red-400
                hover:bg-red-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {deleteLabel ?? "Delete"}
            </button>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
}
