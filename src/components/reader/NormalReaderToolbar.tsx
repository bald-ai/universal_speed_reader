import { motion } from "framer-motion";

export type NormalReaderToolbarState = "edge" | "expanded" | "hidden";

type NormalReaderToolbarProps = {
  state: NormalReaderToolbarState;
  chapterTitle: string;
  progressPercent: number | null;
  progressGradient: {
    from: string;
    via: string;
    to: string;
  };
  onBack: () => void;
  onChapterAction: () => void;
  onSettings: () => void;
};

export default function NormalReaderToolbar({
  state,
  chapterTitle,
  progressPercent,
  progressGradient,
  onBack,
  onChapterAction,
  onSettings,
}: NormalReaderToolbarProps) {
  const expanded = state === "expanded";
  const hidden = state === "hidden";
  const clampedProgress = progressPercent === null
    ? 0
    : Math.max(0, Math.min(100, Math.round(progressPercent)));
  const iconButtonClass = `absolute top-1/2 flex h-[38px] w-[38px] min-w-0 -translate-y-1/2 items-center justify-center
    text-neutral-300
    transition-[opacity,transform] duration-[880ms] ease-[cubic-bezier(0.16,1,0.3,1)]
    hover:text-neutral-100 active:scale-95
    ${expanded ? "pointer-events-auto translate-x-0 scale-100 opacity-100" : "pointer-events-none scale-75 opacity-0"}`;

  return (
    <div
      className={`relative shrink-0 overflow-visible transition-[height] duration-[1040ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${hidden ? "h-0" : "h-12"}`}
      data-testid="normal-reader-toolbar-anchor"
    >
      <header
        data-testid="normal-reader-toolbar"
        data-state={state}
        data-chrome={expanded ? "flat" : "edge"}
        className={`absolute inset-x-0 top-0 z-20 overflow-hidden
          transition-all duration-[880ms] ease-[cubic-bezier(0.16,1,0.3,1)]
          ${expanded
            ? "h-12 bg-transparent"
            : "h-[30px] bg-transparent"}
          ${hidden ? "pointer-events-none -translate-y-[34px] scale-[0.98] opacity-0" : "translate-y-0 scale-100 opacity-100"}`}
        style={{
          transitionProperty: "height, background-color, opacity, transform",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          aria-hidden={!expanded}
          tabIndex={expanded ? 0 : -1}
          className={`${iconButtonClass} left-3 ${expanded ? "translate-x-0" : "-translate-x-3"}`}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </button>

        <button
          type="button"
          onClick={onChapterAction}
          aria-label={expanded ? "Open chapter navigation" : "Expand reader controls"}
          aria-hidden={hidden}
          tabIndex={hidden ? -1 : 0}
          data-testid="chapter-toolbar-action"
          data-presentation={expanded ? "centered" : "quiet"}
          className={`absolute top-1/2 flex min-w-0 -translate-y-1/2 items-center overflow-hidden whitespace-nowrap text-sm font-medium
            transition-[left,max-width,transform,color] duration-[880ms] ease-[cubic-bezier(0.16,1,0.3,1)]
            hover:text-neutral-100
            ${expanded
              ? "left-1/2 max-w-[calc(100%_-_190px)] -translate-x-1/2 justify-center bg-transparent p-0 text-center text-neutral-100"
              : "left-[18px] max-w-[calc(100%_-_92px)] translate-x-0 justify-start bg-transparent p-0 text-left text-neutral-400"}`}
        >
          <span className="block truncate">{chapterTitle}</span>
        </button>

        <span
          aria-hidden={expanded || hidden}
          data-testid="chapter-progress-label"
          data-visible={!expanded && !hidden}
          className={`absolute top-1/2 -translate-y-1/2 text-[11px] text-neutral-500
            transition-[right,opacity,transform] duration-[880ms] ease-[cubic-bezier(0.16,1,0.3,1)]
            ${expanded ? "right-[58px] opacity-0" : "right-[18px] opacity-100"}`}
        >
          {progressPercent === null ? "" : `${clampedProgress}%`}
        </span>

        <button
          type="button"
          onClick={onSettings}
          aria-label="Settings"
          aria-hidden={!expanded}
          tabIndex={expanded ? 0 : -1}
          className={`${iconButtonClass} right-3 ${expanded ? "translate-x-0" : "translate-x-3"}`}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.212 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />
          </svg>
        </button>

        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-neutral-800">
          <motion.div
            className={`h-full ${clampedProgress > 0 ? "min-w-3" : ""}`}
            aria-hidden="true"
            style={{
              background: `linear-gradient(to right, ${progressGradient.from}, ${progressGradient.via}, ${progressGradient.to})`,
            }}
            initial={false}
            animate={{ width: `${clampedProgress}%` }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />
        </div>
      </header>
    </div>
  );
}
