import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { LibraryEntry } from "@/lib/library/libraryBooks";
import NestedPickPrune, {
  collectPickPruneBooks,
  type PickPruneFolderNode,
  type PickPruneTreeNode,
} from "@/components/library/NestedPickPrune";
import LibraryBulkBar from "@/components/library/LibraryBulkBar";
import { useLibraryLongPress } from "@/components/library/useLibraryLongPress";
import {
  collectSelectedBookIds,
  countBooksInFolderIds,
  formatLibrarySelectionCount,
  getMovableSelection,
  getRootSelectedFolderIds,
  librarySelectionKey,
  listAllLibrarySelectionKeys,
  setFolderSubtreeSelected,
  syncCascadeFolderSelection,
  toggleLibrarySelection,
} from "@/lib/library/bulkSelection";
import {
  getBookIdsInFolderSubtree,
  getFolderDescendantIds,
  getFolderPathLabels,
  getParentIdForBook,
  moveBookToFolder,
  moveLibraryFolder,
  reorderLibraryLevel,
  updateLibraryFolder,
} from "@/lib/libraryLayoutStore";
import { getBookCoverPlaceholder } from "@/lib/library/coverPlaceholders";
import { addBookIdsToMood, loadMoods, saveMoods } from "@/lib/moodStore";
import { MOOD_ICONS, getIconEmoji } from "@/lib/moodIcons";
import BookFormatBadge from "@/components/library/BookFormatBadge";
import type { Mood } from "@/types/book";
import type { LibraryFolder, LibraryLayout, LibraryLayoutItemId } from "@/types/libraryLayout";

export type BulkLibraryDeleteRequest =
  | { mode: "books"; bookIds: string[] }
  | { mode: "folders-only"; folderIds: string[] }
  | { mode: "folders-with-contents"; folderIds: string[]; bookIds: string[] };

type LibraryTreeViewProps = {
  entries: LibraryEntry[];
  layout: LibraryLayout;
  isLoading: boolean;
  deletingBookId: string | null;
  busyBookIds: Set<string>;
  onLayoutChange: (layout: LibraryLayout) => void | Promise<void>;
  onCreateFolder: (parentId: string | null) => void;
  onDeleteFolderOnly: (folderId: string) => void;
  onDeleteFolderWithContents: (folderId: string) => void;
  onBulkDelete: (request: BulkLibraryDeleteRequest) => void | Promise<void>;
  onOpenBook: (entry: LibraryEntry) => void;
  onEditBook: (entry: LibraryEntry) => void;
  onDeleteBook: (entry: LibraryEntry) => void;
};

type DragData = {
  kind: "folder" | "book";
  id: string;
  parentId: string | null;
};

type MoodAssignmentTarget =
  | {
      kind: "book";
      title: string;
      bookIds: string[];
    }
  | {
      kind: "folder";
      title: string;
      root: PickPruneFolderNode;
    };

const FOLDER_COLORS = ["violet", "cyan", "emerald", "rose", "amber", "sky", "lime", "fuchsia"];
const DEFAULT_FOLDER_COLOR = "violet";

function itemKey(item: LibraryLayoutItemId): string {
  return `${item.kind}:${item.id}`;
}

function parseItemKey(value: string): LibraryLayoutItemId | null {
  const [kind, id] = value.split(":");
  if ((kind !== "folder" && kind !== "book") || !id) return null;
  return { kind, id };
}

function folderColorClass(color: string | undefined): string {
  const key = color ?? DEFAULT_FOLDER_COLOR;
  const map: Record<string, string> = {
    violet: "from-violet-500/25 to-cyan-500/10 text-violet-100 border-violet-400/25",
    cyan: "from-cyan-500/25 to-teal-500/10 text-cyan-100 border-cyan-400/25",
    emerald: "from-emerald-500/25 to-lime-500/10 text-emerald-100 border-emerald-400/25",
    rose: "from-rose-500/25 to-pink-500/10 text-rose-100 border-rose-400/25",
    amber: "from-amber-500/25 to-orange-500/10 text-amber-100 border-amber-400/25",
    sky: "from-sky-500/25 to-blue-500/10 text-sky-100 border-sky-400/25",
    lime: "from-lime-500/25 to-green-500/10 text-lime-100 border-lime-400/25",
    fuchsia: "from-fuchsia-500/25 to-violet-500/10 text-fuchsia-100 border-fuchsia-400/25",
  };
  return map[key] ?? map.violet;
}

function sortFolders(folders: LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

function sortEntriesForParent(
  entries: LibraryEntry[],
  layout: LibraryLayout,
  parentId: string | null
): LibraryEntry[] {
  const placementByBookId = new Map(layout.placements.map((placement) => [placement.bookId, placement]));
  return entries
    .filter((entry) => {
      const placement = placementByBookId.get(entry.id);
      return (placement?.parentId ?? null) === parentId;
    })
    .sort((a, b) => {
      const placementA = placementByBookId.get(a.id);
      const placementB = placementByBookId.get(b.id);
      const orderA = placementA?.order ?? Number.MAX_SAFE_INTEGER;
      const orderB = placementB?.order ?? Number.MAX_SAFE_INTEGER;
      return orderA - orderB || a.title.localeCompare(b.title);
    });
}

function buildFolderPickPruneTree(
  folder: LibraryFolder,
  entries: LibraryEntry[],
  layout: LibraryLayout
): PickPruneFolderNode {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const childFolders = sortFolders(layout.folders.filter((candidate) => candidate.parentId === folder.id));
  const childBooks = layout.placements
    .filter((placement) => placement.parentId === folder.id)
    .sort((a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId))
    .map((placement) => entryById.get(placement.bookId))
    .filter((entry): entry is LibraryEntry => !!entry);

  const children: PickPruneTreeNode[] = [
    ...childFolders.map((child) => buildFolderPickPruneTree(child, entries, layout)),
    ...childBooks.map((entry) => ({
      kind: "book" as const,
      id: entry.id,
      name: entry.title,
      subtitle: entry.author ?? "Unknown author",
      ...(entry.sourceFormat ? { sourceFormat: entry.sourceFormat } : {}),
    })),
  ];

  return {
    kind: "folder",
    id: `library-folder:${folder.id}`,
    label: folder.label,
    children,
  };
}

function RowActionsMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { open, onOpenChange, children } = props;
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="Actions"
        onClick={() => onOpenChange(!open)}
        onPointerDown={(event) => event.stopPropagation()}
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-black/20 text-xs font-bold text-neutral-200 transition-colors hover:bg-black/35"
      >
        ...
      </button>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close actions"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => onOpenChange(false)}
            onPointerDown={(event) => event.stopPropagation()}
          />
          <div
            className="absolute right-0 top-[calc(100%+6px)] z-50 w-44 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl shadow-black/60"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {children}
          </div>
        </>
      ) : null}
    </div>
  );
}

function RowActionItem(props: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { children, danger, disabled, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        danger ? "text-red-300 hover:bg-red-500/10" : "text-neutral-200 hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function SelectionCheckbox(props: {
  checked: boolean;
  partial?: boolean;
  disabled?: boolean;
  label: string;
  onToggle: () => void;
}) {
  const { checked, partial, disabled, label, onToggle } = props;
  return (
    <button
      type="button"
      aria-label={label}
      aria-checked={partial && !checked ? "mixed" : checked}
      role="checkbox"
      disabled={disabled}
      data-testid="library-selection-checkbox"
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onToggle();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg disabled:opacity-45"
    >
      <span
        aria-hidden="true"
        className={`inline-flex h-5 w-5 items-center justify-center rounded-md border-[1.5px] ${
          checked
            ? "border-cyan-400/70 bg-cyan-400/20 text-cyan-100"
            : partial
              ? "border-cyan-400/55 bg-cyan-400/12 text-cyan-100"
              : "border-neutral-600 bg-neutral-950/45 text-transparent"
        }`}
      >
        {partial && !checked ? (
          <span className="block h-0.5 w-2.5 rounded-sm bg-current" />
        ) : (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.2L5 8.7L9.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  );
}

function SortableShell(props: {
  id: string;
  data: DragData;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const { id, data, disabled, children } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data,
    disabled: !!disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
      }}
      {...attributes}
      {...(disabled ? {} : listeners)}
    >
      {children}
    </div>
  );
}

function FolderRow(props: {
  folder: LibraryFolder;
  depth: number;
  childCount: number;
  expanded: boolean;
  isSelecting: boolean;
  isSelected: boolean;
  isPartial: boolean;
  inputArmored: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCreateChild: () => void;
  onSendToMood: () => void;
  onDelete: () => void;
  onEnterSelect: () => void;
  onToggleSelect: () => void;
}) {
  const {
    folder,
    depth,
    childCount,
    expanded,
    isSelecting,
    isSelected,
    isPartial,
    inputArmored,
    onToggle,
    onEdit,
    onCreateChild,
    onSendToMood,
    onDelete,
    onEnterSelect,
    onToggleSelect,
  } = props;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { isOver, setNodeRef } = useDroppable({
    id: `drop-folder:${folder.id}`,
    data: { kind: "folder-drop", folderId: folder.id },
    disabled: isSelecting,
  });
  const longPress = useLibraryLongPress({
    disabled: isSelecting,
    onLongPress: onEnterSelect,
  });
  const icon = getIconEmoji(folder.icon) ?? "📁";
  return (
    <div
      ref={setNodeRef}
      data-testid={`library-folder-row-${folder.id}`}
      className={`relative rounded-xl border bg-gradient-to-br ${folderColorClass(folder.color)} px-3 py-2 transition-shadow ${
        isSelected ? "shadow-[0_0_0_1px_rgba(34,211,238,0.55)]" : isOver ? "shadow-[0_0_0_1px_rgba(103,232,249,0.75)]" : ""
      }`}
      style={{ marginLeft: depth * 14 }}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={longPress.onContextMenu}
      onClick={() => {
        if (!isSelecting || inputArmored) return;
        onToggleSelect();
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/20 text-sm text-neutral-100"
          aria-label={expanded ? "Collapse folder" : "Expand folder"}
        >
          {expanded ? "⌄" : "›"}
        </button>
        <div className="text-base leading-none">{icon}</div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (isSelecting) {
              if (!inputArmored) onToggleSelect();
              return;
            }
            onToggle();
          }}
          className="min-w-0 flex-1 text-left"
        >
          <div className="truncate text-sm font-semibold text-neutral-50">{folder.label}</div>
          <div className="text-[11px] text-neutral-400">{childCount} items</div>
        </button>
        {isSelecting ? (
          <SelectionCheckbox
            checked={isSelected}
            partial={isPartial}
            disabled={inputArmored}
            label={isSelected ? `Deselect ${folder.label}` : `Select ${folder.label}`}
            onToggle={onToggleSelect}
          />
        ) : (
          <RowActionsMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            <RowActionItem onClick={() => { setIsMenuOpen(false); onCreateChild(); }}>
              New subfolder
            </RowActionItem>
            <RowActionItem onClick={() => { setIsMenuOpen(false); onSendToMood(); }}>
              Send to mood...
            </RowActionItem>
            <RowActionItem onClick={() => { setIsMenuOpen(false); onEdit(); }}>
              Edit
            </RowActionItem>
            <RowActionItem danger onClick={() => { setIsMenuOpen(false); onDelete(); }}>
              Delete
            </RowActionItem>
          </RowActionsMenu>
        )}
      </div>
    </div>
  );
}

function BookRow(props: {
  entry: LibraryEntry;
  depth: number;
  isDeleting: boolean;
  isBusy: boolean;
  isSelecting: boolean;
  isSelected: boolean;
  inputArmored: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: () => void;
  onSendToMood: () => void;
  onDelete: () => void;
  onEnterSelect: () => void;
  onToggleSelect: () => void;
}) {
  const {
    entry,
    depth,
    isDeleting,
    isBusy,
    isSelecting,
    isSelected,
    inputArmored,
    onOpen,
    onEdit,
    onMove,
    onSendToMood,
    onDelete,
    onEnterSelect,
    onToggleSelect,
  } = props;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const canEdit = entry.processingStatus === "completed" || entry.processingStatus === "failed";
  const canOpen = entry.processingStatus === "completed";
  const hasWarnings = entry.processingWarnings.length > 0;
  const coverUrl = entry.coverUrl ?? getBookCoverPlaceholder(entry.progressPercent);
  const longPress = useLibraryLongPress({
    disabled: isSelecting,
    onLongPress: onEnterSelect,
  });

  const handleActivate = () => {
    if (isSelecting) {
      if (!inputArmored) onToggleSelect();
      return;
    }
    onOpen();
  };

  return (
    <div
      data-testid={`library-book-row-${entry.id}`}
      className={`relative rounded-xl border border-neutral-800/70 bg-neutral-900/80 px-3 py-2 ${
        isSelected ? "shadow-[0_0_0_1px_rgba(34,211,238,0.55)]" : ""
      }`}
      style={{ marginLeft: depth * 14 }}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={longPress.onContextMenu}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleActivate}
          disabled={!isSelecting && (!canOpen || isDeleting || isBusy)}
          className="shrink-0 disabled:opacity-50"
        >
          <img src={coverUrl} alt="" className="h-12 w-9 rounded-md bg-neutral-800 object-cover" loading="lazy" decoding="async" />
        </button>
        <button
          type="button"
          onClick={handleActivate}
          disabled={!isSelecting && (!canOpen || isDeleting || isBusy)}
          className="min-w-0 flex-1 text-left disabled:opacity-50"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">{entry.title}</div>
            <BookFormatBadge format={entry.sourceFormat} />
          </div>
          <div className="truncate text-xs text-neutral-500">{entry.author}</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-0.5 w-16 overflow-hidden rounded-full bg-neutral-800">
              <div className="h-full rounded-full bg-cyan-400" style={{ width: `${entry.progressPercent}%` }} />
            </div>
            <span className="text-[11px] text-neutral-500">{entry.processingStatus !== "completed" ? entry.processingStatusLabel : `${entry.progressPercent}%`}</span>
          </div>
        </button>
        {hasWarnings && !isSelecting ? (
          <button
            type="button"
            data-testid={`library-warning-${entry.id}`}
            aria-label="Import warnings"
            title="Import warnings"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-amber-500/15 text-[11px] font-bold text-amber-200"
            onClick={() => setShowWarnings((current) => !current)}
          >
            !
          </button>
        ) : null}
        {isSelecting ? (
          <SelectionCheckbox
            checked={isSelected}
            disabled={inputArmored}
            label={isSelected ? `Deselect ${entry.title}` : `Select ${entry.title}`}
            onToggle={onToggleSelect}
          />
        ) : (
          <RowActionsMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
            {canEdit ? (
              <RowActionItem disabled={isDeleting || isBusy} onClick={() => { setIsMenuOpen(false); onEdit(); }}>
                {isBusy ? "Working..." : "Edit"}
              </RowActionItem>
            ) : null}
            <RowActionItem disabled={isDeleting || isBusy} onClick={() => { setIsMenuOpen(false); onMove(); }}>
              Move to folder...
            </RowActionItem>
            <RowActionItem disabled={isDeleting || isBusy} onClick={() => { setIsMenuOpen(false); onSendToMood(); }}>
              Send to mood...
            </RowActionItem>
            <RowActionItem danger disabled={isDeleting || isBusy} onClick={() => { setIsMenuOpen(false); onDelete(); }}>
              {isDeleting ? "Deleting..." : "Delete"}
            </RowActionItem>
          </RowActionsMenu>
        )}
      </div>
      {showWarnings && hasWarnings && !isSelecting ? (
        <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100">
          {entry.processingWarnings.map((warning) => (
            <p key={warning.code} className="leading-relaxed">
              {warning.message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FolderEditSheet(props: {
  folder: LibraryFolder;
  onClose: () => void;
  onSave: (folder: LibraryFolder) => void;
}) {
  const { folder, onClose, onSave } = props;
  const [label, setLabel] = useState(folder.label);
  const [icon, setIcon] = useState(folder.icon);
  const [color, setColor] = useState(folder.color ?? DEFAULT_FOLDER_COLOR);
  return (
    <div className="fixed inset-x-3 bottom-0 z-50 rounded-t-2xl border border-neutral-800 bg-neutral-900 p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl shadow-black/60">
      <div className="text-sm font-semibold text-neutral-100">Edit folder</div>
      <input
        autoFocus
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className="mt-3 w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-cyan-400/60"
        placeholder="Folder name"
      />
      <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-neutral-500">Icon</div>
      <div className="mt-2 grid grid-cols-8 gap-1.5">
        {MOOD_ICONS.slice(0, 24).map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setIcon(option.key)}
            className={`aspect-square rounded-lg text-base ${icon === option.key ? "bg-cyan-400/20 ring-1 ring-cyan-300/50" : "bg-neutral-800"}`}
          >
            {option.emoji}
          </button>
        ))}
      </div>
      <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-neutral-500">Color</div>
      <div className="mt-2 grid grid-cols-8 gap-1.5">
        {FOLDER_COLORS.map((option) => (
          <button
            key={option}
            type="button"
            title={option}
            onClick={() => setColor(option)}
            className={`h-8 rounded-lg border bg-gradient-to-br ${folderColorClass(option)} ${color === option ? "ring-1 ring-white/50" : ""}`}
          />
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave({ ...folder, label: label.trim() || folder.label, icon, color })}
          className="flex-1 rounded-xl border border-cyan-300/30 bg-cyan-400/15 px-4 py-2 text-sm font-semibold text-cyan-100"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function DeleteFolderDialog(props: {
  folder: LibraryFolder;
  bookCount: number;
  onCancel: () => void;
  onDeleteOnly: () => void;
  onDeleteWithContents: () => void;
}) {
  const { folder, bookCount, onCancel, onDeleteOnly, onDeleteWithContents } = props;
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="w-full rounded-2xl border border-neutral-800 bg-neutral-900 p-4 shadow-2xl shadow-black/60">
        <div className="text-base font-semibold text-neutral-100">Delete {folder.label}?</div>
        <p className="mt-1 text-sm text-neutral-400">
          Choose whether books stay in your Library or get deleted too.
        </p>
        <div className="mt-4 grid gap-2">
          <button type="button" onClick={onDeleteOnly} className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-left text-sm font-semibold text-neutral-100">
            Delete folder only
            <span className="block text-xs font-normal text-neutral-500">Move contents up one level.</span>
          </button>
          <button type="button" onClick={onDeleteWithContents} className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-left text-sm font-semibold text-red-200">
            Delete folder + contents
            <span className="block text-xs font-normal text-red-200/70">Delete {bookCount} books from the app.</span>
          </button>
          <button type="button" onClick={onCancel} className="rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveBookSheet(props: {
  entry: LibraryEntry;
  layout: LibraryLayout;
  onClose: () => void;
  onMove: (parentId: string | null) => void;
}) {
  const { entry, layout, onClose, onMove } = props;
  const folders = sortFolders(layout.folders);
  const currentParentId = getParentIdForBook(layout, entry.id);
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="max-h-[78dvh] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="border-b border-neutral-800 p-4">
          <div className="text-sm font-semibold text-neutral-100">Move to folder...</div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate text-xs text-neutral-500">{entry.title}</div>
            <BookFormatBadge format={entry.sourceFormat} />
          </div>
        </div>
        <div className="max-h-[58dvh] overflow-auto p-2">
          <button
            type="button"
            onClick={() => onMove(null)}
            className={`w-full rounded-xl px-3 py-2 text-left text-sm ${currentParentId === null ? "bg-cyan-400/15 text-cyan-100" : "text-neutral-200 hover:bg-neutral-800"}`}
          >
            Library root
          </button>
          {folders.map((folder) => {
            const path = [...getFolderPathLabels(layout, folder.parentId), folder.label].join(" / ");
            return (
              <button
                key={folder.id}
                type="button"
                onClick={() => onMove(folder.id)}
                className={`mt-1 w-full rounded-xl px-3 py-2 text-left text-sm ${currentParentId === folder.id ? "bg-cyan-400/15 text-cyan-100" : "text-neutral-200 hover:bg-neutral-800"}`}
              >
                {path}
              </button>
            );
          })}
        </div>
        <div className="border-t border-neutral-800 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button type="button" onClick={onClose} className="w-full rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveSelectionSheet(props: {
  summary: string;
  layout: LibraryLayout;
  disabledFolderIds: Set<string>;
  onClose: () => void;
  onMove: (parentId: string | null) => void;
}) {
  const { summary, layout, disabledFolderIds, onClose, onMove } = props;
  const folders = sortFolders(layout.folders);
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="max-h-[78dvh] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="border-b border-neutral-800 p-4">
          <div className="text-sm font-semibold text-neutral-100">Move to folder...</div>
          <div className="mt-1 truncate text-xs text-neutral-500">{summary}</div>
        </div>
        <div className="max-h-[58dvh] overflow-auto p-2">
          <button
            type="button"
            onClick={() => onMove(null)}
            className="w-full rounded-xl px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
          >
            Library root
          </button>
          {folders.map((folder) => {
            const path = [...getFolderPathLabels(layout, folder.parentId), folder.label].join(" / ");
            const disabled = disabledFolderIds.has(folder.id);
            return (
              <button
                key={folder.id}
                type="button"
                disabled={disabled}
                onClick={() => onMove(folder.id)}
                className="mt-1 w-full rounded-xl px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {path}
              </button>
            );
          })}
        </div>
        <div className="border-t border-neutral-800 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button type="button" onClick={onClose} className="w-full rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkDeleteFoldersDialog(props: {
  folderCount: number;
  bookCount: number;
  onCancel: () => void;
  onDeleteOnly: () => void;
  onDeleteWithContents: () => void;
}) {
  const { folderCount, bookCount, onCancel, onDeleteOnly, onDeleteWithContents } = props;
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="w-full rounded-2xl border border-neutral-800 bg-neutral-900 p-4 shadow-2xl shadow-black/60">
        <div className="text-base font-semibold text-neutral-100">
          Delete {folderCount} folder{folderCount === 1 ? "" : "s"}?
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          Choose whether books stay in your Library or get deleted too.
        </p>
        <div className="mt-4 grid gap-2">
          <button type="button" onClick={onDeleteOnly} className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-left text-sm font-semibold text-neutral-100">
            Delete folders only
            <span className="block text-xs font-normal text-neutral-500">Move contents up one level.</span>
          </button>
          <button type="button" onClick={onDeleteWithContents} className="rounded-xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-left text-sm font-semibold text-red-200">
            Delete folders + contents
            <span className="block text-xs font-normal text-red-200/70">
              Delete {bookCount} book{bookCount === 1 ? "" : "s"} from the app.
            </span>
          </button>
          <button type="button" onClick={onCancel} className="rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function MoodAssignmentSheet(props: {
  title: string;
  bookIds: string[];
  onClose: () => void;
  onAssigned: () => void;
}) {
  const { title, bookIds, onClose, onAssigned } = props;
  const [moods, setMoods] = useState<Mood[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingMoodId, setSavingMoodId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    loadMoods()
      .then((loadedMoods) => {
        if (cancelled) return;
        setMoods(loadedMoods);
        setError(null);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load moods");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const assignToMood = (moodId: string) => {
    setSavingMoodId(moodId);
    setError(null);
    loadMoods()
      .then((currentMoods) => {
        const nextMoods = addBookIdsToMood(currentMoods, moodId, bookIds);
        return saveMoods(nextMoods).then(() => nextMoods);
      })
      .then((nextMoods) => {
        setMoods(nextMoods);
        onAssigned();
        onClose();
      })
      .catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "Failed to save mood");
      })
      .finally(() => setSavingMoodId(null));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="max-h-[78dvh] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="border-b border-neutral-800 p-4">
          <div className="text-sm font-semibold text-neutral-100">Send to mood...</div>
          <div className="mt-1 truncate text-xs text-neutral-500">
            {title} · {bookIds.length} {bookIds.length === 1 ? "book" : "books"}
          </div>
        </div>
        <div className="max-h-[58dvh] overflow-auto p-2">
          {isLoading ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              Loading moods...
            </div>
          ) : moods.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              No moods yet.
            </div>
          ) : bookIds.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              This folder has no books to send.
            </div>
          ) : (
            moods.map((mood) => {
              const alreadyAssigned = bookIds.every((bookId) => mood.bookIds.includes(bookId));
              return (
                <button
                  key={mood.id}
                  type="button"
                  disabled={savingMoodId !== null || alreadyAssigned}
                  onClick={() => assignToMood(mood.id)}
                  className="mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="truncate">{mood.label}</span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {savingMoodId === mood.id ? "Saving..." : alreadyAssigned ? "Already there" : "Send"}
                  </span>
                </button>
              );
            })
          )}
          {error ? (
            <div className="mt-2 rounded-xl border border-red-500/35 bg-red-950/35 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          ) : null}
        </div>
        <div className="border-t border-neutral-800 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button type="button" onClick={onClose} className="w-full rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderToMoodSheet(props: {
  title: string;
  root: PickPruneFolderNode;
  onClose: () => void;
}) {
  const { title, root, onClose } = props;
  const [moods, setMoods] = useState<Mood[]>([]);
  const [selectedMood, setSelectedMood] = useState<Mood | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bookCount = collectPickPruneBooks(root).length;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    loadMoods()
      .then((loadedMoods) => {
        if (cancelled) return;
        setMoods(loadedMoods);
        setError(null);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load moods");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addSelectedBooks = (bookIds: string[]) => {
    if (!selectedMood) return;
    setIsSaving(true);
    setError(null);
    loadMoods()
      .then((currentMoods) => {
        const nextMoods = addBookIdsToMood(currentMoods, selectedMood.id, bookIds);
        return saveMoods(nextMoods);
      })
      .then(onClose)
      .catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "Failed to save mood");
      })
      .finally(() => setIsSaving(false));
  };

  if (selectedMood) {
    return (
      <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
        <div className="max-h-[92dvh] w-full overflow-auto pb-[env(safe-area-inset-bottom,0px)]">
          <NestedPickPrune
            root={root}
            title={`Add to ${selectedMood.label}`}
            description="Remove any books you do not want in this mood. Your Library folders stay unchanged."
            confirmLabel="Add selected"
            showKeptSize={false}
            isBusy={isSaving}
            onCancel={onClose}
            onConfirm={addSelectedBooks}
          />
          {error ? (
            <div className="mt-2 rounded-xl border border-red-500/35 bg-red-950/35 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/55 px-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
      <div className="max-h-[78dvh] w-full overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl shadow-black/60">
        <div className="border-b border-neutral-800 p-4">
          <div className="text-sm font-semibold text-neutral-100">Send folder to mood...</div>
          <div className="mt-1 truncate text-xs text-neutral-500">
            {title} · {bookCount} {bookCount === 1 ? "book" : "books"}
          </div>
        </div>
        <div className="max-h-[58dvh] overflow-auto p-2">
          {isLoading ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              Loading moods...
            </div>
          ) : moods.length === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              No moods yet.
            </div>
          ) : bookCount === 0 ? (
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/45 px-3 py-3 text-sm text-neutral-500">
              This folder has no books to send.
            </div>
          ) : (
            moods.map((mood) => (
              <button
                key={mood.id}
                type="button"
                onClick={() => setSelectedMood(mood)}
                className="mb-1 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-neutral-200 hover:bg-neutral-800"
              >
                <span className="truncate">{mood.label}</span>
                <span className="shrink-0 text-xs text-neutral-500">Choose</span>
              </button>
            ))
          )}
          {error ? (
            <div className="mt-2 rounded-xl border border-red-500/35 bg-red-950/35 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          ) : null}
        </div>
        <div className="border-t border-neutral-800 p-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button type="button" onClick={onClose} className="w-full rounded-xl border border-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-300">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LibraryTreeView(props: LibraryTreeViewProps) {
  const {
    entries,
    layout,
    isLoading,
    deletingBookId,
    busyBookIds,
    onLayoutChange,
    onCreateFolder,
    onDeleteFolderOnly,
    onDeleteFolderWithContents,
    onBulkDelete,
    onOpenBook,
    onEditBook,
    onDeleteBook,
  } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingFolder, setEditingFolder] = useState<LibraryFolder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<LibraryFolder | null>(null);
  const [movingBook, setMovingBook] = useState<LibraryEntry | null>(null);
  const [movingSelection, setMovingSelection] = useState(false);
  const [bulkDeleteFolders, setBulkDeleteFolders] = useState<{
    folderIds: string[];
    bookIds: string[];
    bookCount: number;
  } | null>(null);
  const [moodAssignmentTarget, setMoodAssignmentTarget] = useState<MoodAssignmentTarget | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [partialFolderIds, setPartialFolderIds] = useState<Set<string>>(() => new Set());
  const [inputArmored, setInputArmored] = useState(false);
  const armorTimerRef = useRef<number>(0);
  // Distance-based drag so a still long-press can enter multi-select.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const foldersForParent = useCallback(
    (parentId: string | null) => sortFolders(layout.folders.filter((folder) => folder.parentId === parentId)),
    [layout.folders]
  );

  const entriesForParent = useCallback(
    (parentId: string | null) => sortEntriesForParent(entries, layout, parentId),
    [entries, layout]
  );

  const levelItems = useCallback(
    (parentId: string | null): LibraryLayoutItemId[] => [
      ...foldersForParent(parentId).map((folder) => ({ kind: "folder" as const, id: folder.id })),
      ...entriesForParent(parentId).map((entry) => ({ kind: "book" as const, id: entry.id })),
    ],
    [entriesForParent, foldersForParent]
  );

  const applyLayout = useCallback(
    (next: LibraryLayout) => {
      void onLayoutChange(next);
    },
    [onLayoutChange]
  );

  const armAgainstGhostClick = useCallback(() => {
    setInputArmored(true);
    window.clearTimeout(armorTimerRef.current);
    armorTimerRef.current = window.setTimeout(() => {
      setInputArmored(false);
    }, 450);
  }, []);

  const applySelection = useCallback((nextSelected: Set<string>) => {
    const synced = syncCascadeFolderSelection(nextSelected, layout);
    setSelected(synced.selected);
    setPartialFolderIds(synced.partialFolderIds);
  }, [layout]);

  const exitSelecting = useCallback(() => {
    setIsSelecting(false);
    setSelected(new Set());
    setPartialFolderIds(new Set());
    setMovingSelection(false);
    setBulkDeleteFolders(null);
  }, []);

  const enterSelecting = useCallback((item: LibraryLayoutItemId) => {
    setIsSelecting(true);
    armAgainstGhostClick();
    if (item.kind === "folder") {
      applySelection(setFolderSubtreeSelected(new Set(), layout, item.id, true));
    } else {
      applySelection(new Set([librarySelectionKey(item)]));
    }
  }, [applySelection, armAgainstGhostClick, layout]);

  const selectionSummary = useMemo(
    () => formatLibrarySelectionCount(selected),
    [selected]
  );

  const allSelectionKeys = useMemo(() => listAllLibrarySelectionKeys(layout), [layout]);
  const allSelected =
    allSelectionKeys.length > 0 && allSelectionKeys.every((key) => selected.has(key));

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (isSelecting) return;
      const active = parseItemKey(String(event.active.id));
      if (!active || !event.over) return;
      const overId = String(event.over.id);

      if (overId.startsWith("drop-folder:")) {
        const targetFolderId = overId.replace("drop-folder:", "");
        const next =
          active.kind === "folder"
            ? moveLibraryFolder(layout, active.id, targetFolderId)
            : moveBookToFolder(layout, active.id, targetFolderId);
        setExpanded((current) => new Set(current).add(targetFolderId));
        applyLayout(next);
        return;
      }

      const over = parseItemKey(overId);
      if (!over) return;
      const overData = event.over.data.current as DragData | undefined;
      const activeData = event.active.data.current as DragData | undefined;
      const parentId = overData?.parentId ?? activeData?.parentId ?? null;
      const currentItems = levelItems(parentId);
      const activeIndex = currentItems.findIndex((item) => item.kind === active.kind && item.id === active.id);
      const overIndex = currentItems.findIndex((item) => item.kind === over.kind && item.id === over.id);
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return;
      applyLayout(reorderLibraryLevel(layout, parentId, arrayMove(currentItems, activeIndex, overIndex)));
    },
    [applyLayout, isSelecting, layout, levelItems]
  );

  const handleBulkDelete = useCallback(() => {
    if (selected.size === 0 || inputArmored) return;
    const rootFolderIds = getRootSelectedFolderIds(selected, layout);
    const selectedBookIds = collectSelectedBookIds(selected);
    if (rootFolderIds.length === 0) {
      void onBulkDelete({ mode: "books", bookIds: selectedBookIds });
      exitSelecting();
      return;
    }
    const folderBookCount = countBooksInFolderIds(layout, rootFolderIds);
    const booksOutsideFolders = selectedBookIds.filter((bookId) => {
      return !rootFolderIds.some((folderId) =>
        getBookIdsInFolderSubtree(layout, folderId).includes(bookId)
      );
    });
    if (folderBookCount === 0 && booksOutsideFolders.length === 0) {
      void onBulkDelete({ mode: "folders-only", folderIds: rootFolderIds });
      exitSelecting();
      return;
    }
    setBulkDeleteFolders({
      folderIds: rootFolderIds,
      bookIds: selectedBookIds,
      bookCount: folderBookCount + booksOutsideFolders.length,
    });
  }, [exitSelecting, inputArmored, layout, onBulkDelete, selected]);

  const handleBulkMove = useCallback((parentId: string | null) => {
    const movable = getMovableSelection(selected, layout);
    let next = layout;
    for (const folderId of movable.folderIds) {
      next = moveLibraryFolder(next, folderId, parentId);
    }
    for (const bookId of movable.bookIds) {
      next = moveBookToFolder(next, bookId, parentId);
    }
    applyLayout(next);
    if (parentId) {
      setExpanded((current) => new Set(current).add(parentId));
    }
    setMovingSelection(false);
    exitSelecting();
  }, [applyLayout, exitSelecting, layout, selected]);

  const disabledMoveFolderIds = useMemo(() => {
    const movable = getMovableSelection(selected, layout);
    const blocked = new Set<string>();
    for (const folderId of movable.folderIds) {
      for (const id of getFolderDescendantIds(layout, folderId)) {
        blocked.add(id);
      }
    }
    return blocked;
  }, [layout, selected]);

  const renderLevel = (parentId: string | null, depth: number): ReactNode => {
    const folders = foldersForParent(parentId);
    const books = entriesForParent(parentId);
    const sortableItems = levelItems(parentId).map(itemKey);
    return (
      <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {folders.map((folder) => {
            const isExpanded = expanded.has(folder.id);
            const childCount = foldersForParent(folder.id).length + entriesForParent(folder.id).length;
            const folderKey = librarySelectionKey({ kind: "folder", id: folder.id });
            return (
              <div key={folder.id} className="space-y-3">
                <SortableShell
                  id={itemKey({ kind: "folder", id: folder.id })}
                  data={{ kind: "folder", id: folder.id, parentId }}
                  disabled={isSelecting}
                >
                  <FolderRow
                    folder={folder}
                    depth={depth}
                    childCount={childCount}
                    expanded={isExpanded}
                    isSelecting={isSelecting}
                    isSelected={selected.has(folderKey)}
                    isPartial={partialFolderIds.has(folder.id)}
                    inputArmored={inputArmored}
                    onToggle={() => {
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(folder.id)) next.delete(folder.id);
                        else next.add(folder.id);
                        return next;
                      });
                    }}
                    onEdit={() => setEditingFolder(folder)}
                    onCreateChild={() => {
                      setExpanded((current) => new Set(current).add(folder.id));
                      onCreateFolder(folder.id);
                    }}
                    onSendToMood={() => {
                      setMoodAssignmentTarget({
                        kind: "folder",
                        title: folder.label,
                        root: buildFolderPickPruneTree(folder, entries, layout),
                      });
                    }}
                    onDelete={() => setDeletingFolder(folder)}
                    onEnterSelect={() => enterSelecting({ kind: "folder", id: folder.id })}
                    onToggleSelect={() => {
                      applySelection(
                        toggleLibrarySelection(selected, layout, { kind: "folder", id: folder.id })
                      );
                    }}
                  />
                </SortableShell>
                {isExpanded ? renderLevel(folder.id, depth + 1) : null}
              </div>
            );
          })}
          {books.map((entry) => {
            const isDeleting = deletingBookId === entry.id;
            const isBusy = busyBookIds.has(entry.id);
            const bookKey = librarySelectionKey({ kind: "book", id: entry.id });
            return (
              <SortableShell
                key={entry.id}
                id={itemKey({ kind: "book", id: entry.id })}
                data={{ kind: "book", id: entry.id, parentId }}
                disabled={isSelecting}
              >
                <BookRow
                  entry={entry}
                  depth={depth}
                  isDeleting={isDeleting}
                  isBusy={isBusy}
                  isSelecting={isSelecting}
                  isSelected={selected.has(bookKey)}
                  inputArmored={inputArmored}
                  onOpen={() => onOpenBook(entry)}
                  onEdit={() => onEditBook(entry)}
                  onMove={() => setMovingBook(entry)}
                  onSendToMood={() => {
                    setMoodAssignmentTarget({
                      kind: "book",
                      title: entry.title,
                      bookIds: [entry.id],
                    });
                  }}
                  onDelete={() => onDeleteBook(entry)}
                  onEnterSelect={() => enterSelecting({ kind: "book", id: entry.id })}
                  onToggleSelect={() => {
                    applySelection(
                      toggleLibrarySelection(selected, layout, { kind: "book", id: entry.id })
                    );
                  }}
                />
              </SortableShell>
            );
          })}
        </div>
      </SortableContext>
    );
  };

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm text-neutral-400">
        Loading library…
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 px-4 py-4 text-sm text-neutral-400">
        No books yet. Import an EPUB or PDF to start reading.
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-[calc(env(safe-area-inset-bottom,0px)+12rem)]">
      {isSelecting ? (
        <LibraryBulkBar
          summary={selectionSummary}
          selectAllLabel={allSelected ? "Clear" : "Select all"}
          disabled={selected.size === 0 || inputArmored}
          onSelectAll={() => {
            if (allSelected) {
              applySelection(new Set());
              return;
            }
            applySelection(new Set(allSelectionKeys));
          }}
          onMove={() => {
            if (selected.size === 0 || inputArmored) return;
            setMovingSelection(true);
          }}
          onSendToMood={() => {
            if (selected.size === 0 || inputArmored) return;
            const bookIds = collectSelectedBookIds(selected);
            setMoodAssignmentTarget({
              kind: "book",
              title: selectionSummary,
              bookIds,
            });
          }}
          onCancel={exitSelecting}
          onDelete={handleBulkDelete}
        />
      ) : (
        <button
          type="button"
          onClick={() => onCreateFolder(null)}
          className="w-full rounded-2xl border border-dashed border-neutral-700 bg-neutral-900/20 px-4 py-3 text-sm font-semibold text-neutral-400 hover:border-cyan-400/40 hover:text-cyan-200"
        >
          + New folder
        </button>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        {renderLevel(null, 0)}
      </DndContext>

      {editingFolder ? (
        <FolderEditSheet
          folder={editingFolder}
          onClose={() => setEditingFolder(null)}
          onSave={(folder) => {
            applyLayout(updateLibraryFolder(layout, folder.id, folder));
            setEditingFolder(null);
          }}
        />
      ) : null}

      {deletingFolder ? (
        <DeleteFolderDialog
          folder={deletingFolder}
          bookCount={getBookIdsInFolderSubtree(layout, deletingFolder.id).length}
          onCancel={() => setDeletingFolder(null)}
          onDeleteOnly={() => {
            onDeleteFolderOnly(deletingFolder.id);
            setDeletingFolder(null);
          }}
          onDeleteWithContents={() => {
            onDeleteFolderWithContents(deletingFolder.id);
            setDeletingFolder(null);
          }}
        />
      ) : null}

      {bulkDeleteFolders ? (
        <BulkDeleteFoldersDialog
          folderCount={bulkDeleteFolders.folderIds.length}
          bookCount={bulkDeleteFolders.bookCount}
          onCancel={() => setBulkDeleteFolders(null)}
          onDeleteOnly={() => {
            void onBulkDelete({ mode: "folders-only", folderIds: bulkDeleteFolders.folderIds });
            setBulkDeleteFolders(null);
            exitSelecting();
          }}
          onDeleteWithContents={() => {
            void onBulkDelete({
              mode: "folders-with-contents",
              folderIds: bulkDeleteFolders.folderIds,
              bookIds: bulkDeleteFolders.bookIds,
            });
            setBulkDeleteFolders(null);
            exitSelecting();
          }}
        />
      ) : null}

      {movingBook ? (
        <MoveBookSheet
          entry={movingBook}
          layout={layout}
          onClose={() => setMovingBook(null)}
          onMove={(parentId) => {
            applyLayout(moveBookToFolder(layout, movingBook.id, parentId));
            setMovingBook(null);
          }}
        />
      ) : null}

      {movingSelection ? (
        <MoveSelectionSheet
          summary={selectionSummary}
          layout={layout}
          disabledFolderIds={disabledMoveFolderIds}
          onClose={() => setMovingSelection(false)}
          onMove={handleBulkMove}
        />
      ) : null}

      {moodAssignmentTarget?.kind === "book" ? (
        <MoodAssignmentSheet
          title={moodAssignmentTarget.title}
          bookIds={moodAssignmentTarget.bookIds}
          onClose={() => setMoodAssignmentTarget(null)}
          onAssigned={() => {
            if (isSelecting) exitSelecting();
          }}
        />
      ) : null}
      {moodAssignmentTarget?.kind === "folder" ? (
        <FolderToMoodSheet
          title={moodAssignmentTarget.title}
          root={moodAssignmentTarget.root}
          onClose={() => setMoodAssignmentTarget(null)}
        />
      ) : null}
    </div>
  );
}
