import { describe, expect, it } from "bun:test";
import {
  stopBatchImportAfterFailure,
  watchBatchImportAbort,
} from "./batchImportCancellation";

describe("watchBatchImportAbort", () => {
  it("cancels currently tracked books as soon as the batch signal aborts", async () => {
    const tracked = ["book-a", "book-b"];
    let canceledIds: string[] = [];
    let resolveCanceled!: () => void;
    const canceled = new Promise<void>((resolve) => {
      resolveCanceled = resolve;
    });

    const controller = new AbortController();
    const stop = watchBatchImportAbort(
      controller.signal,
      () => tracked,
      async (bookIds) => {
        canceledIds = bookIds;
        resolveCanceled();
      }
    );

    // Simulate: imports already returned for A/B while another file read is still pending.
    const pendingRead = new Promise<void>(() => undefined);
    controller.abort();

    await canceled;
    expect(canceledIds).toEqual(["book-a", "book-b"]);
    expect(pendingRead).toBeInstanceOf(Promise);

    stop();
  });

  it("is idempotent across repeated abort notifications", async () => {
    const tracked = ["book-a"];
    let calls = 0;
    const controller = new AbortController();

    watchBatchImportAbort(controller.signal, () => tracked, async () => {
      calls += 1;
    });

    controller.abort();
    controller.abort();
    await Promise.resolve();
    expect(calls).toBe(1);
  });

  it("runs immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let canceledIds: string[] = [];

    watchBatchImportAbort(
      controller.signal,
      () => ["already-tracked"],
      async (bookIds) => {
        canceledIds = bookIds;
      }
    );

    await Promise.resolve();
    expect(canceledIds).toEqual(["already-tracked"]);
  });

  it("aborts and waits for scoped cancellation after orchestration fails", async () => {
    const controller = new AbortController();
    let releaseCancellation!: () => void;
    const cancellationBlocked = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let cancellationSawAbort = false;
    let settled = false;

    const stopping = stopBatchImportAfterFailure(
      controller,
      () => ["book-a", "book-a", "book-b"],
      async (bookIds) => {
        cancellationSawAbort = controller.signal.aborted;
        expect(bookIds).toEqual(["book-a", "book-b"]);
        await cancellationBlocked;
      }
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(cancellationSawAbort).toBe(true);
    expect(settled).toBe(false);

    releaseCancellation();
    await stopping;
    expect(settled).toBe(true);
  });
});
