type LibraryBulkBarProps = {
  summary: string;
  selectAllLabel: string;
  disabled?: boolean;
  onSelectAll: () => void;
  onMove: () => void;
  onSendToMood: () => void;
  onCancel: () => void;
  onDelete: () => void;
};

export default function LibraryBulkBar(props: LibraryBulkBarProps) {
  const {
    summary,
    selectAllLabel,
    disabled,
    onSelectAll,
    onMove,
    onSendToMood,
    onCancel,
    onDelete,
  } = props;
  return (
    <div
      className="flex items-center gap-1.5 rounded-2xl border border-violet-400/25 bg-violet-500/10 px-2 py-1.5"
      role="toolbar"
      aria-label="Bulk actions"
      data-testid="library-bulk-bar"
    >
      <span
        className="min-w-0 flex-1 truncate text-[11px] font-semibold text-violet-100"
        data-testid="library-select-chip"
        title={summary}
      >
        {summary}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-semibold text-violet-200 hover:bg-violet-400/10"
        data-testid="library-select-all"
        onClick={onSelectAll}
      >
        {selectAllLabel === "Select all" ? "All" : "Clear"}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onMove}
        className="shrink-0 rounded-md border border-neutral-700/80 bg-neutral-950/35 px-2 py-1 text-[11px] font-semibold text-neutral-100 hover:bg-neutral-800 disabled:opacity-45"
        data-testid="library-bulk-move"
      >
        Move
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onSendToMood}
        className="shrink-0 rounded-md border border-neutral-700/80 bg-neutral-950/35 px-2 py-1 text-[11px] font-semibold text-neutral-100 hover:bg-neutral-800 disabled:opacity-45"
        data-testid="library-bulk-mood"
      >
        Mood
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded-md border border-neutral-700/80 bg-neutral-950/35 px-2 py-1 text-[11px] font-semibold text-neutral-300 hover:bg-neutral-800"
        data-testid="library-bulk-cancel"
      >
        Cancel
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onDelete}
        className="shrink-0 rounded-md border border-red-500/35 bg-red-500/10 px-2 py-1 text-[11px] font-semibold text-red-200 disabled:opacity-45"
        data-testid="library-bulk-delete"
      >
        Delete
      </button>
    </div>
  );
}
