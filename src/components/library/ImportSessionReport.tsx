import { useState, type ReactNode } from "react";
import type { LastImportBookResult } from "@/components/library/LastImportReport";

export type ImportSessionCurrent = {
  fileName: string;
  phaseLabel: string;
};

type ImportSessionReportProps = {
  totalCount: number;
  completedCount: number;
  withIssuesCount: number;
  failedCount: number;
  canceledCount: number;
  isCanceling: boolean;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
  current: ImportSessionCurrent | null;
  books: LastImportBookResult[];
  onCancel: () => void;
};

const OK_PREVIEW_LIMIT = 8;

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatRemaining(milliseconds: number | null): string | null {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds <= 0) {
    return null;
  }
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  if (totalSeconds < 60) return `~${totalSeconds}s left`;
  const minutes = Math.ceil(totalSeconds / 60);
  return `~${minutes} min left`;
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function ProgressIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[15px] w-[15px]" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.5-6.5l-2 2M8.5 15.5l-2 2m0-11l2 2m9 9l-2-2"
      />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[15px] w-[15px]" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
      />
    </svg>
  );
}

function OkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[15px] w-[15px]" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  );
}

function FailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[15px] w-[15px]" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

function CanceledIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[15px] w-[15px]" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M8 12h8" />
    </svg>
  );
}

type BucketProps = {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  iconClassName: string;
  title: string;
  helper: string;
  count: number;
  children: ReactNode;
  testId: string;
};

function ImportBucket(props: BucketProps) {
  const { open, onToggle, icon, iconClassName, title, helper, count, children, testId } = props;
  return (
    <div className="border-t border-neutral-800/80" data-testid={testId}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 min-h-[52px] px-4 py-3 text-left hover:bg-white/[0.025] transition-colors"
      >
        <span className={`shrink-0 grid place-items-center h-7 w-7 rounded-lg ${iconClassName}`}>{icon}</span>
        <span className="min-w-0 flex-1 flex flex-col gap-0.5">
          <span className="text-sm font-semibold text-neutral-100">{title}</span>
          <span className="text-xs text-neutral-500 truncate">{helper}</span>
        </span>
        <span className="text-sm font-semibold tabular-nums text-neutral-400 min-w-[1.5ch] text-right">{count}</span>
        <ChevronIcon className={`h-4 w-4 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? children : null}
    </div>
  );
}

function BookRow({ book, showReason }: { book: LastImportBookResult; showReason: boolean }) {
  return (
    <li className="min-w-0">
      <p className="truncate text-[13px] font-medium text-neutral-100">{book.fileName}</p>
      {showReason && book.reason ? (
        <p className="mt-0.5 text-xs leading-snug text-neutral-400">{book.reason}</p>
      ) : null}
    </li>
  );
}

export default function ImportSessionReport(props: ImportSessionReportProps) {
  const {
    totalCount,
    completedCount,
    withIssuesCount,
    failedCount,
    canceledCount,
    isCanceling,
    elapsedMs,
    estimatedRemainingMs,
    current,
    books,
    onCancel,
  } = props;

  const finishedCount = completedCount + failedCount + canceledCount;
  const okCount = Math.max(0, completedCount - withIssuesCount);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [failedOpen, setFailedOpen] = useState(false);
  const [canceledOpen, setCanceledOpen] = useState(false);
  const [okOpen, setOkOpen] = useState(false);

  const issueBooks = books.filter((book) => book.status === "with_issues");
  const failedBooks = books.filter((book) => book.status === "failed");
  const canceledBooks = books.filter((book) => book.status === "canceled");
  const okBooks = books.filter((book) => book.status === "ok");
  const okPreview = okBooks.slice(0, OK_PREVIEW_LIMIT);
  const okRemaining = Math.max(0, okBooks.length - okPreview.length);

  const outcomeParts: string[] = [];
  if (withIssuesCount > 0) outcomeParts.push(`${withIssuesCount} with issues`);
  if (failedCount > 0) outcomeParts.push(`${failedCount} failed`);
  if (canceledCount > 0) outcomeParts.push(`${canceledCount} canceled`);
  outcomeParts.push(`${okCount} ok`);

  const remainingLabel = formatRemaining(estimatedRemainingMs);
  const metaParts = isCanceling
    ? ["Screen stays on", "keep this app open"]
    : [
        "Screen stays on",
        "keep this app open",
        ...(remainingLabel ? [remainingLabel] : [formatDuration(elapsedMs)]),
      ];

  return (
    <section
      className="rounded-2xl bg-neutral-900/90 overflow-hidden shadow-[0_1px_0_rgba(64,64,64,0.9),0_8px_28px_rgba(0,0,0,0.35)]"
      data-testid="import-session-report"
      aria-label={isCanceling ? "Canceling import" : "Importing"}
      aria-modal="true"
      role="dialog"
    >
      <div className="flex items-stretch gap-1 p-1">
        <div
          className="min-w-0 flex-1 min-h-[72px] flex flex-col justify-center gap-1.5 px-4 py-3 text-left rounded-xl"
          data-testid="import-session-summary"
        >
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-neutral-100">
              {isCanceling ? "Canceling" : "Importing"}
            </h2>
          </div>
          <p className="text-sm text-neutral-400">
            <span className="font-medium text-neutral-100">
              {finishedCount} of {totalCount}
            </span>
            {isCanceling ? " · stopping current book" : null}
            {!isCanceling && outcomeParts.length > 0 ? (
              <>
                {" · "}
                {outcomeParts.join(" · ")}
              </>
            ) : null}
          </p>
          <p className="text-xs text-neutral-500 tabular-nums">{metaParts.join(" · ")}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          disabled={isCanceling}
          className="shrink-0 self-center inline-flex items-center justify-center gap-1.5 min-h-12 min-w-12 mr-1 px-3 rounded-xl text-[13px] font-medium text-neutral-400 hover:text-neutral-100 hover:bg-white/[0.04] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400 disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-neutral-400"
          aria-label={isCanceling ? "Canceling import" : "Cancel import"}
          data-testid="import-session-cancel"
        >
          <span>{isCanceling ? "Canceling…" : "Cancel"}</span>
        </button>
      </div>

      <div data-testid="import-session-body">
        <div className="border-t border-neutral-800/80" data-testid="import-session-current">
          <div className="flex w-full items-center gap-3 min-h-[52px] px-4 py-3 text-left">
            <span className="shrink-0 grid place-items-center h-7 w-7 rounded-lg bg-violet-500/14 text-violet-300">
              <ProgressIcon />
            </span>
            <span className="min-w-0 flex-1 flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-neutral-100">
                {isCanceling ? "Stopping safely" : "Now processing"}
              </span>
              <span className="text-xs text-neutral-500 truncate">
                {current
                  ? `${current.fileName} · ${current.phaseLabel}`
                  : isCanceling
                    ? "Finishing cancel cleanup"
                    : "Reading selected files"}
              </span>
            </span>
            <span className="text-sm font-semibold tabular-nums text-neutral-400 min-w-[1.5ch] text-right">1</span>
          </div>
        </div>

        {failedCount > 0 ? (
          <ImportBucket
            open={failedOpen}
            onToggle={() => setFailedOpen((open) => !open)}
            icon={<FailIcon />}
            iconClassName="bg-rose-500/12 text-rose-300"
            title="Failed"
            helper="Not in library — import the file again"
            count={failedCount}
            testId="import-session-bucket-failed"
          >
            <ul className="grid gap-3 px-4 pb-4 pl-14">
              {failedBooks.map((book) => (
                <BookRow key={book.id} book={book} showReason />
              ))}
            </ul>
          </ImportBucket>
        ) : null}

        {withIssuesCount > 0 ? (
          <ImportBucket
            open={issuesOpen}
            onToggle={() => setIssuesOpen((open) => !open)}
            icon={<WarnIcon />}
            iconClassName="bg-amber-500/12 text-amber-200"
            title="With issues"
            helper="In library — openable with warnings"
            count={withIssuesCount}
            testId="import-session-bucket-issues"
          >
            <ul className="grid gap-3 px-4 pb-4 pl-14">
              {issueBooks.map((book) => (
                <BookRow key={book.id} book={book} showReason />
              ))}
            </ul>
          </ImportBucket>
        ) : null}

        {canceledCount > 0 ? (
          <ImportBucket
            open={canceledOpen}
            onToggle={() => setCanceledOpen((open) => !open)}
            icon={<CanceledIcon />}
            iconClassName="bg-neutral-500/15 text-neutral-300"
            title="Canceled"
            helper="Skipped when import was canceled"
            count={canceledCount}
            testId="import-session-bucket-canceled"
          >
            <ul className="grid gap-3 px-4 pb-4 pl-14">
              {canceledBooks.map((book) => (
                <BookRow key={book.id} book={book} showReason={false} />
              ))}
            </ul>
          </ImportBucket>
        ) : null}

        {okCount > 0 ? (
          <ImportBucket
            open={okOpen}
            onToggle={() => setOkOpen((open) => !open)}
            icon={<OkIcon />}
            iconClassName="bg-emerald-500/12 text-emerald-300"
            title="OK"
            helper="Imported cleanly"
            count={okCount}
            testId="import-session-bucket-ok"
          >
            <ul className="grid gap-1 px-4 pb-3 pl-14 max-h-36 overflow-y-auto">
              {okPreview.map((book) => (
                <li key={book.id} className="min-w-0 py-1">
                  <p className="truncate text-[13px] font-normal text-neutral-400">{book.fileName}</p>
                </li>
              ))}
              {okRemaining > 0 ? (
                <li className="text-xs text-neutral-500 pt-1">+ {okRemaining.toLocaleString()} more</li>
              ) : null}
            </ul>
          </ImportBucket>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 bg-neutral-800/40 border-t border-neutral-800/80">
          <p className="m-0 flex-1 min-w-[180px] text-xs text-neutral-400">
            {isCanceling
              ? "Don’t leave until this closes — cancel is still finishing."
              : "Don’t switch apps or lock the phone — leaving can stop the import."}
          </p>
        </div>
      </div>
    </section>
  );
}
