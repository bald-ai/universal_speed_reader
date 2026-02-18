import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { LibraryEntry } from "@/lib/library/libraryBooks";
import {
  CoverValidationError,
  getCoverValidationErrorMessage,
  validateAndReadCoverFile,
} from "@/lib/library/coverUploadValidation";

const MAX_TITLE_LENGTH = 160;
const MAX_AUTHOR_LENGTH = 160;

export type EditBookModalSavePayload = {
  title: string;
  author: string | null;
  coverDataUrl?: string | null;
};

type EditBookModalProps = {
  entry: LibraryEntry | null;
  isSaving: boolean;
  isRestoring: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (payload: EditBookModalSavePayload) => Promise<void>;
  onRestore: () => Promise<void>;
};

export default function EditBookModal(props: EditBookModalProps) {
  const { entry, isSaving, isRestoring, error, onClose, onSave, onRestore } = props;
  const [titleDraft, setTitleDraft] = useState("");
  const [authorDraft, setAuthorDraft] = useState("");
  const [coverDataUrl, setCoverDataUrl] = useState<string | undefined>(undefined);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [isReadingCover, setIsReadingCover] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setTitleDraft(entry.title);
    setAuthorDraft(entry.author);
    setCoverDataUrl(undefined);
    setCoverError(null);
    setIsReadingCover(false);
  }, [entry]);

  const isBusy = isSaving || isRestoring || isReadingCover;
  const titleValue = titleDraft.trim();
  const previewUrl = coverDataUrl ?? entry?.coverUrl ?? null;
  const saveDisabled = isBusy || titleValue.length === 0;

  const helperText = useMemo(() => {
    if (isReadingCover) return "Validating cover image…";
    if (coverError) return coverError;
    return null;
  }, [coverError, isReadingCover]);

  if (!entry) return null;

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    const selectedFile = selectedFiles[0];
    event.target.value = "";

    setIsReadingCover(true);
    setCoverError(null);
    try {
      const result = await validateAndReadCoverFile(selectedFile);
      setCoverDataUrl(result.dataUrl);
    } catch (unknownError) {
      if (unknownError instanceof CoverValidationError) {
        setCoverError(getCoverValidationErrorMessage(unknownError.code));
      } else {
        setCoverError("Could not read this image file.");
      }
    } finally {
      setIsReadingCover(false);
    }
  };

  const handleSave = async () => {
    if (saveDisabled) return;
    const nextAuthor = authorDraft.trim();
    const payload: EditBookModalSavePayload = {
      title: titleValue,
      author: nextAuthor.length > 0 ? nextAuthor : null,
    };
    if (coverDataUrl !== undefined) {
      payload.coverDataUrl = coverDataUrl;
    }
    await onSave(payload);
  };

  const handleRestore = async () => {
    if (isBusy) return;
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            `Restore "${entry.title}" to the original uploaded EPUB?\n\nThis will replace title, author, cover, text content, and reset reading progress.`
          );
    if (!confirmed) return;
    await onRestore();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close edit modal"
        onClick={onClose}
        disabled={isBusy}
        className="absolute inset-0 bg-black/70 disabled:cursor-not-allowed"
      />

      <div className="relative z-10 w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-4 shadow-2xl shadow-black/60">
        <h3 className="text-base font-semibold text-neutral-100">Edit book</h3>
        <p className="mt-1 text-xs text-neutral-400">Update title, author, or cover image.</p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">
              Title
            </span>
            <input
              type="text"
              value={titleDraft}
              maxLength={MAX_TITLE_LENGTH}
              disabled={isBusy}
              onChange={(event) => setTitleDraft(event.target.value)}
              className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-violet-400 disabled:opacity-60"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">
              Author
            </span>
            <input
              type="text"
              value={authorDraft}
              maxLength={MAX_AUTHOR_LENGTH}
              disabled={isBusy}
              onChange={(event) => setAuthorDraft(event.target.value)}
              className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-violet-400 disabled:opacity-60"
            />
          </label>
        </div>

        <div className="mt-4">
          <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">
            Cover
          </span>
          <div className="flex items-start gap-3">
            <div className="h-24 w-16 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950">
              {previewUrl ? (
                <img src={previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-500">
                  No cover
                </div>
              )}
            </div>
            <div className="flex-1 space-y-2">
              <label className="inline-block">
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    void handleFileChange(event);
                  }}
                  disabled={isBusy}
                />
                <span className="inline-flex cursor-pointer rounded-xl border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-100 transition-colors hover:bg-neutral-700">
                  Replace cover
                </span>
              </label>
              {coverDataUrl !== undefined ? (
                <button
                  type="button"
                  onClick={() => setCoverDataUrl(undefined)}
                  disabled={isBusy}
                  className="block rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs font-semibold text-neutral-200 disabled:opacity-60"
                >
                  Use current cover
                </button>
              ) : null}
              <p className="text-[11px] text-neutral-500">Accepted: JPG, PNG, WEBP up to 5MB.</p>
            </div>
          </div>
          {helperText ? (
            <p className="mt-2 text-xs text-red-300">{helperText}</p>
          ) : null}
        </div>

        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/30 p-3">
          <p className="text-xs text-amber-200">
            Restore to original will re-import from the uploaded EPUB and reset reading progress.
          </p>
        </div>

        {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={saveDisabled}
            className="flex-1 rounded-xl bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-900 transition-colors hover:bg-white disabled:bg-neutral-800 disabled:text-neutral-400"
          >
            {isSaving ? "Saving..." : "Save changes"}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleRestore();
            }}
            disabled={isBusy}
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:border-neutral-700 disabled:bg-neutral-800 disabled:text-neutral-400"
          >
            {isRestoring ? "Restoring..." : "Restore to original"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-semibold text-neutral-200 transition-colors hover:bg-neutral-800 disabled:text-neutral-500"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
