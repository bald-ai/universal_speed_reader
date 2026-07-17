import { useState, type ReactNode } from "react";
import { buildImportIssueMailto } from "@/lib/supportContact";

export type LastImportBookStatus = "ok" | "with_issues" | "failed" | "canceled";

export type LastImportBookResult = {
  id: string;
  fileName: string;
  status: LastImportBookStatus;
  reason: string | null;
  sizeBytes: number;
};

export type LastImportSummary = {
  bookCount: number;
  completedCount: number;
  withIssuesCount: number;
  failedCount: number;
  canceledCount: number;
  totalBytes: number;
  elapsedMs: number;
  books: LastImportBookResult[];
};

type LastImportReportProps = {
  summary: LastImportSummary;
  onDismiss: () => void;
};

const OK_PREVIEW_LIMIT = 8;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatRate(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "--";
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
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
          <span className="text-xs text-neutral-500">{helper}</span>
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

export default function LastImportReport({ summary, onDismiss }: LastImportReportProps) {
  const okCount = Math.max(0, summary.completedCount - summary.withIssuesCount);
  const [reportOpen, setReportOpen] = useState(true);
  const [failedOpen, setFailedOpen] = useState(summary.failedCount > 0);
  const [issuesOpen, setIssuesOpen] = useState(
    summary.failedCount === 0 && summary.withIssuesCount > 0
  );
  const [canceledOpen, setCanceledOpen] = useState(false);
  const [okOpen, setOkOpen] = useState(false);

  const failedBooks = summary.books.filter((book) => book.status === "failed");
  const issueBooks = summary.books.filter((book) => book.status === "with_issues");
  const canceledBooks = summary.books.filter((book) => book.status === "canceled");
  const okBooks = summary.books.filter((book) => book.status === "ok");
  const okPreview = okBooks.slice(0, OK_PREVIEW_LIMIT);
  const okRemaining = Math.max(0, okBooks.length - okPreview.length);

  const perBookMs = summary.elapsedMs / Math.max(1, summary.bookCount);
  const perMbMs = summary.elapsedMs / Math.max(0.001, summary.totalBytes / (1024 * 1024));

  const outcomeParts: Array<{ key: string; text: string; emphasize?: boolean }> = [];
  if (summary.failedCount > 0) {
    outcomeParts.push({
      key: "failed",
      text: `${summary.failedCount} failed`,
      emphasize: true,
    });
  }
  if (summary.withIssuesCount > 0) {
    outcomeParts.push({ key: "issues", text: `${summary.withIssuesCount} with issues` });
  }
  if (summary.canceledCount > 0) {
    outcomeParts.push({ key: "canceled", text: `${summary.canceledCount} canceled` });
  }
  outcomeParts.push({ key: "ok", text: `${okCount} ok` });

  const showEmail = summary.failedCount > 0 || summary.withIssuesCount > 0;
  const emailHref = buildImportIssueMailto(
    summary.books
      .filter(
        (book): book is LastImportBookResult & { status: "with_issues" | "failed" } =>
          book.status === "with_issues" || book.status === "failed"
      )
      .map((book) => ({
        fileName: book.fileName,
        status: book.status,
        reason: book.reason,
      }))
  );

  return (
    <section
      className="rounded-2xl bg-neutral-900/90 overflow-hidden shadow-[0_1px_0_rgba(64,64,64,0.9),0_8px_28px_rgba(0,0,0,0.35)]"
      data-testid="last-import-report"
      aria-label="Last import"
    >
      <div className="flex items-stretch gap-1 p-1">
        <button
          type="button"
          onClick={() => setReportOpen((open) => !open)}
          aria-expanded={reportOpen}
          aria-controls="last-import-report-body"
          className="min-w-0 flex-1 min-h-[72px] flex flex-col justify-center gap-1.5 px-4 py-3 text-left rounded-xl hover:bg-white/[0.03] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
          data-testid="last-import-report-toggle"
        >
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-neutral-100">Last import</h2>
            <ChevronIcon
              className={`h-4 w-4 text-neutral-500 transition-transform ${reportOpen ? "" : "-rotate-90"}`}
            />
          </div>
          <p className="text-sm text-neutral-400">
            {outcomeParts.map((part, index) => (
              <span key={part.key}>
                {index > 0 ? " · " : null}
                {part.emphasize ? (
                  <span className="font-medium text-neutral-100">{part.text}</span>
                ) : (
                  part.text
                )}
              </span>
            ))}
          </p>
          <p className="text-xs text-neutral-500 tabular-nums">
            {formatDuration(summary.elapsedMs)}
            {" · "}
            {formatRate(perBookMs)}/book
            {" · "}
            {formatRate(perMbMs)}/MB
            {" · "}
            {formatBytes(summary.totalBytes)}
          </p>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 self-center inline-flex items-center justify-center gap-1.5 min-h-12 min-w-12 mr-1 px-3 rounded-xl text-[13px] font-medium text-neutral-400 hover:text-neutral-100 hover:bg-white/[0.04] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400"
          aria-label="Dismiss last import report"
          data-testid="last-import-report-dismiss"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span>Dismiss</span>
        </button>
      </div>

      {reportOpen ? (
        <div id="last-import-report-body" data-testid="last-import-report-body">
          {summary.failedCount > 0 ? (
            <ImportBucket
              open={failedOpen}
              onToggle={() => setFailedOpen((open) => !open)}
              icon={<FailIcon />}
              iconClassName="bg-rose-500/12 text-rose-300"
              title="Failed"
              helper="Not in library — import the file again"
              count={summary.failedCount}
              testId="last-import-bucket-failed"
            >
              <ul className="grid gap-3 px-4 pb-4 pl-14">
                {failedBooks.map((book) => (
                  <BookRow key={book.id} book={book} showReason />
                ))}
              </ul>
            </ImportBucket>
          ) : null}

          {summary.withIssuesCount > 0 ? (
            <ImportBucket
              open={issuesOpen}
              onToggle={() => setIssuesOpen((open) => !open)}
              icon={<WarnIcon />}
              iconClassName="bg-amber-500/12 text-amber-200"
              title="With issues"
              helper="In library — openable with warnings"
              count={summary.withIssuesCount}
              testId="last-import-bucket-issues"
            >
              <ul className="grid gap-3 px-4 pb-4 pl-14">
                {issueBooks.map((book) => (
                  <BookRow key={book.id} book={book} showReason />
                ))}
              </ul>
            </ImportBucket>
          ) : null}

          {summary.canceledCount > 0 ? (
            <ImportBucket
              open={canceledOpen}
              onToggle={() => setCanceledOpen((open) => !open)}
              icon={<CanceledIcon />}
              iconClassName="bg-neutral-500/15 text-neutral-300"
              title="Canceled"
              helper="Skipped when import was canceled"
              count={summary.canceledCount}
              testId="last-import-bucket-canceled"
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
              testId="last-import-bucket-ok"
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

          {showEmail ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 bg-neutral-800/40 border-t border-neutral-800/80">
              <p className="m-0 flex-1 min-w-[180px] text-xs text-neutral-400">
                Something look wrong? Email the files — replies within 24h.
              </p>
              <a
                href={emailHref}
                className="inline-flex items-center min-h-11 px-1 text-[13px] font-medium text-violet-300 hover:text-violet-200 underline-offset-2 hover:underline transition-colors"
                data-testid="last-import-report-email"
              >
                Email about this import
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
