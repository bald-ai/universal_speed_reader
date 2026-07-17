/**
 * Cancels already-enqueued batch books as soon as the batch AbortSignal fires,
 * without waiting for outstanding File.arrayBuffer / native reads to finish.
 */
export function watchBatchImportAbort(
  signal: AbortSignal,
  getTrackedBookIds: () => readonly string[],
  cancelBooks: (bookIds: string[]) => Promise<void>
): () => void {
  let ran = false;
  const run = () => {
    if (ran) return;
    ran = true;
    const ids = Array.from(getTrackedBookIds());
    if (ids.length === 0) return;
    void cancelBooks(ids);
  };

  if (signal.aborted) {
    run();
    return () => undefined;
  }

  signal.addEventListener("abort", run);
  return () => {
    signal.removeEventListener("abort", run);
  };
}

/**
 * Stops every enqueued book owned by a batch after its orchestration fails.
 * Awaiting this keeps the foreground session locked until scoped cancellation
 * has removed queued/active importer work.
 */
export async function stopBatchImportAfterFailure(
  controller: AbortController,
  getTrackedBookIds: () => readonly string[],
  cancelBooks: (bookIds: string[]) => Promise<void>
): Promise<void> {
  controller.abort();
  const ids = Array.from(new Set(getTrackedBookIds()));
  if (ids.length === 0) return;
  await cancelBooks(ids);
}
