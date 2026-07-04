type BulkImportFile = {
  name: string;
  size: number;
};

type BulkImportReviewProps = {
  files: BulkImportFile[];
  description?: string;
  completedCount: number;
  failedCount: number;
  isImporting: boolean;
  elapsedMs?: number;
  processedBytes?: number;
  onStart: () => void;
  onCancel: () => void;
};

const PREVIEW_LIMIT = 4;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function estimateLocalStorageBytes(sourceBytes: number): number {
  return Math.ceil(sourceBytes * 1.18);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatTimingValue(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return "--";
  }
  if (milliseconds < 1000) {
    return `${Math.max(1, Math.round(milliseconds))} ms`;
  }
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

export default function BulkImportReview(props: BulkImportReviewProps) {
  const {
    files,
    description,
    completedCount,
    failedCount,
    isImporting,
    elapsedMs = 0,
    processedBytes = 0,
    onStart,
    onCancel,
  } = props;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const estimatedStorageBytes = estimateLocalStorageBytes(totalBytes);
  const remainingPreviewCount = Math.max(0, files.length - PREVIEW_LIMIT);
  const finishedCount = completedCount + failedCount;
  const progressPercent = files.length > 0 ? Math.round((finishedCount / files.length) * 100) : 0;
  const averageBookMs = finishedCount > 0 ? elapsedMs / finishedCount : null;
  const processedMb = processedBytes / (1024 * 1024);
  const averageMbMs = processedMb > 0 ? elapsedMs / processedMb : null;
  const shouldShowTiming = isImporting || elapsedMs > 0;

  return (
    <section
      className="rounded-2xl border border-violet-400/35 bg-neutral-900/80 overflow-hidden shadow-xl shadow-black/20"
      data-testid="bulk-import-review"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 h-11 w-11 rounded-xl border border-violet-400/25 bg-violet-500/15 flex items-center justify-center text-violet-300">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 5.25A2.25 2.25 0 016.75 3h7.5L19.5 8.25v10.5A2.25 2.25 0 0117.25 21H6.75a2.25 2.25 0 01-2.25-2.25V5.25z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-neutral-100 leading-tight">
              {files.length.toLocaleString()} EPUB{files.length === 1 ? "" : "s"} selected
            </h2>
            <p className="mt-1 text-sm text-neutral-400 leading-relaxed">
              {description ?? "Android picked the files. Review the batch before adding it to your library."}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4">
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Files</div>
            <div className="mt-1 text-lg font-semibold text-neutral-100">{files.length}</div>
          </div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Source</div>
            <div className="mt-1 text-lg font-semibold text-neutral-100">{formatBytes(totalBytes)}</div>
          </div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Stored</div>
            <div className="mt-1 text-lg font-semibold text-neutral-100">{formatBytes(estimatedStorageBytes)}</div>
          </div>
        </div>

        {isImporting ? (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span>Processing {finishedCount} of {files.length}</span>
              <span>{progressPercent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400 transition-[width]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        {shouldShowTiming ? (
          <div className="grid grid-cols-2 gap-2 mt-4">
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Elapsed</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{formatDuration(elapsedMs)}</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Per book</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{formatTimingValue(averageBookMs)}</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Per MB</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{formatTimingValue(averageMbMs)}</div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Processed</div>
              <div className="mt-1 text-sm font-semibold text-neutral-100">{formatBytes(processedBytes)}</div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950/35 overflow-hidden">
          {files.slice(0, PREVIEW_LIMIT).map((file) => (
            <div key={`${file.name}-${file.size}`} className="flex items-center gap-3 px-3 py-2 border-b border-neutral-800/70 last:border-b-0">
              <div className="h-8 w-8 rounded-lg bg-neutral-800 flex items-center justify-center text-neutral-500">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7 3h7l4 4v14H7a2 2 0 01-2-2V5a2 2 0 012-2z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-200">{file.name}</div>
                <div className="text-xs text-neutral-500">{formatBytes(file.size)}</div>
              </div>
            </div>
          ))}
          {remainingPreviewCount > 0 ? (
            <div className="px-3 py-2 text-xs text-neutral-500">
              + {remainingPreviewCount.toLocaleString()} more selected
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-neutral-800/80 bg-neutral-950/35 p-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={isImporting}
          className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onStart}
          disabled={isImporting || files.length === 0}
          className="rounded-xl border border-violet-400/50 bg-violet-500/20 px-3 py-2 text-sm font-semibold text-violet-200 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isImporting ? "Processing..." : "Start import"}
        </button>
      </div>
    </section>
  );
}
