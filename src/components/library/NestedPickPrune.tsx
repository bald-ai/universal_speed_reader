import { useMemo, useState } from "react";

export type PickPruneBookNode = {
  kind: "book";
  id: string;
  name: string;
  subtitle?: string;
  size?: number;
};

export type PickPruneFolderNode = {
  kind: "folder";
  id: string;
  label: string;
  children: PickPruneTreeNode[];
};

export type PickPruneTreeNode = PickPruneFolderNode | PickPruneBookNode;

type NestedPickPruneProps = {
  root: PickPruneFolderNode;
  title: string;
  description?: string;
  confirmLabel?: string;
  showKeptSize?: boolean;
  isBusy?: boolean;
  onCancel: () => void;
  onConfirm: (keptBookIds: string[]) => void;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function collectPickPruneBooks(node: PickPruneTreeNode): PickPruneBookNode[] {
  if (node.kind === "book") return [node];
  return node.children.flatMap(collectPickPruneBooks);
}

export function collectPickPruneBookIds(node: PickPruneTreeNode): string[] {
  return collectPickPruneBooks(node).map((book) => book.id);
}

function findNode(node: PickPruneTreeNode, nodeId: string): PickPruneTreeNode | null {
  if (node.id === nodeId) return node;
  if (node.kind === "book") return null;
  for (const child of node.children) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

export function removeNodeFromPickPruneSelection(
  root: PickPruneFolderNode,
  nodeId: string,
  selectedBookIds: string[]
): string[] {
  const target = findNode(root, nodeId);
  if (!target) return selectedBookIds;
  const removing = new Set(collectPickPruneBookIds(target));
  return selectedBookIds.filter((bookId) => !removing.has(bookId));
}

export function restoreBooksToPickPruneSelection(
  selectedBookIds: string[],
  restoringBookIds: string[]
): string[] {
  const next = new Set(selectedBookIds);
  restoringBookIds.forEach((bookId) => next.add(bookId));
  return Array.from(next);
}

function TreeNode(props: {
  node: PickPruneTreeNode;
  depth: number;
  selectedBookIds: Set<string>;
  disabled: boolean;
  onRemove: (nodeId: string) => void;
}) {
  const { node, depth, selectedBookIds, disabled, onRemove } = props;
  const books = useMemo(() => collectPickPruneBooks(node), [node]);
  const selectedCount = books.filter((book) => selectedBookIds.has(book.id)).length;
  const isSelected = node.kind === "book" ? selectedBookIds.has(node.id) : selectedCount > 0;
  if (!isSelected) return null;

  if (node.kind === "book") {
    return (
      <div
        className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-950/35 px-3 py-2"
        style={{ marginLeft: depth * 12 }}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-200">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75v10.5m-4.5-7.5h9" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-neutral-100">{node.name}</div>
          <div className="truncate text-xs text-neutral-500">
            {node.subtitle ?? (node.size !== undefined ? formatBytes(node.size) : "Book")}
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(node.id)}
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
        >
          Remove
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/70 px-3 py-2"
        style={{ marginLeft: depth * 12 }}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-100">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h6l1.5 1.5h9v9a1.5 1.5 0 0 1-1.5 1.5h-15a1.5 1.5 0 0 1-1.5-1.5v-9a1.5 1.5 0 0 1 1.5-1.5Z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-neutral-100">{node.label}</div>
          <div className="text-xs text-neutral-500">
            {selectedCount} of {books.length} kept
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRemove(node.id)}
          className="rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
        >
          Remove
        </button>
      </div>
      <div className="space-y-2">
        {node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedBookIds={selectedBookIds}
            disabled={disabled}
            onRemove={onRemove}
          />
        ))}
      </div>
    </div>
  );
}

export default function NestedPickPrune(props: NestedPickPruneProps) {
  const {
    root,
    title,
    description,
    confirmLabel,
    showKeptSize = true,
    isBusy = false,
    onCancel,
    onConfirm,
  } = props;
  const allBooks = useMemo(() => collectPickPruneBooks(root), [root]);
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>(() => allBooks.map((book) => book.id));
  const selectedSet = useMemo(() => new Set(selectedBookIds), [selectedBookIds]);
  const removedBooks = allBooks.filter((book) => !selectedSet.has(book.id));
  const keptBooks = allBooks.filter((book) => selectedSet.has(book.id));
  const keptBytes = keptBooks.reduce((sum, book) => sum + (book.size ?? 0), 0);

  return (
    <section className="rounded-2xl border border-cyan-400/25 bg-neutral-900/85 p-4 shadow-xl shadow-black/25">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-neutral-100">{title}</h2>
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-neutral-400">{description}</p>
          ) : null}
        </div>
        <div className="shrink-0 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1 text-xs font-semibold text-cyan-100">
          {keptBooks.length}/{allBooks.length}
        </div>
      </div>

      <div className={`mt-3 grid gap-2 ${showKeptSize ? "grid-cols-2" : "grid-cols-1"}`}>
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Kept books</div>
          <div className="mt-1 text-sm font-semibold text-neutral-100">{keptBooks.length}</div>
        </div>
        {showKeptSize ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">Kept size</div>
            <div className="mt-1 text-sm font-semibold text-neutral-100">{formatBytes(keptBytes)}</div>
          </div>
        ) : null}
      </div>

      <div className="mt-4 max-h-[52dvh] space-y-2 overflow-auto pr-1">
        <TreeNode
          node={root}
          depth={0}
          selectedBookIds={selectedSet}
          disabled={isBusy}
          onRemove={(nodeId) => {
            setSelectedBookIds((current) => removeNodeFromPickPruneSelection(root, nodeId, current));
          }}
        />
      </div>

      {removedBooks.length > 0 ? (
        <div className="mt-4 rounded-xl border border-neutral-800 bg-neutral-950/35 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
              Removed ({removedBooks.length})
            </div>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => {
                setSelectedBookIds((current) =>
                  restoreBooksToPickPruneSelection(current, removedBooks.map((book) => book.id))
                );
              }}
              className="text-xs font-semibold text-cyan-200 disabled:opacity-40"
            >
              Restore all
            </button>
          </div>
          <div className="mt-2 space-y-1">
            {removedBooks.slice(0, 6).map((book) => (
              <div key={book.id} className="flex items-center gap-2 text-xs text-neutral-400">
                <span className="min-w-0 flex-1 truncate">{book.name}</span>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => {
                    setSelectedBookIds((current) => restoreBooksToPickPruneSelection(current, [book.id]));
                  }}
                  className="shrink-0 text-cyan-200 disabled:opacity-40"
                >
                  Restore
                </button>
              </div>
            ))}
            {removedBooks.length > 6 ? (
              <div className="text-xs text-neutral-600">+{removedBooks.length - 6} more removed</div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={onCancel}
          className="flex-1 rounded-xl border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-neutral-300 disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isBusy || keptBooks.length === 0}
          onClick={() => onConfirm(keptBooks.map((book) => book.id))}
          className="flex-1 rounded-xl border border-cyan-300/30 bg-cyan-400/15 px-4 py-2.5 text-sm font-semibold text-cyan-100 disabled:opacity-40"
        >
          {isBusy ? "Working..." : confirmLabel ?? `Confirm ${keptBooks.length}`}
        </button>
      </div>
    </section>
  );
}
