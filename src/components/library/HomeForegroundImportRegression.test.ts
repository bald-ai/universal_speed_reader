import { describe, expect, it } from "bun:test";

describe("Home foreground import regression guards", () => {
  it("keeps support navigation disabled while a batch owns the screen", async () => {
    const source = await Bun.file(new URL("../../pages/Home.tsx", import.meta.url)).text();

    expect(source).toContain("aria-disabled={isImportingBatch || undefined}");
    expect(source).toContain("tabIndex={isImportingBatch ? -1 : undefined}");
    expect(source).toContain("if (isImportingBatch) {");
    expect(source).toContain("event.preventDefault();");
  });

  it("only publishes Last import after terminal outcomes were collected", async () => {
    const source = await Bun.file(new URL("../../pages/Home.tsx", import.meta.url)).text();

    expect(source).toContain("let outcomesCollected = false;");
    expect(source).toContain("stopWatchingAbort();");
    expect(source).toContain("abortController.abort();");
    expect(source).toContain("await stopBatchImportAfterFailure(");
    expect(source).toContain("if (outcomesCollected) {");
  });

  it("suppresses full library reloads while a batch is locked", async () => {
    const source = await Bun.file(new URL("../../pages/Home.tsx", import.meta.url)).text();

    // Ref (not state) so the once-registered subscribe callback sees the live lock.
    expect(source).toContain("const isImportingBatchRef = useRef(false);");
    expect(source).toContain("if (isImportingBatchRef.current) return;");
    expect(source).toContain("isImportingBatchRef.current = true;");
    expect(source).toContain("isImportingBatchRef.current = false;");
    // Clear any debounce queued just before lock so it cannot fire mid-batch.
    expect(source).toContain("importRefreshTimeoutRef.current = null;");
    // One refresh on every exit path before unlock (including error).
    expect(source).toContain("await refreshLibrary({ showLoading: false });");
    expect(source.indexOf("await refreshLibrary({ showLoading: false });")).toBeGreaterThan(
      source.indexOf("} finally {")
    );
  });

  it("serializes batch file reads with parsing", async () => {
    const source = await Bun.file(new URL("../../pages/Home.tsx", import.meta.url)).text();

    expect(source).toContain("const BATCH_IMPORT_READ_CONCURRENCY = 1;");
    expect(source).toContain("await importService.waitForIdle(signal);");
    expect(source.indexOf("await importService.waitForIdle(signal);")).toBeLessThan(
      source.indexOf("const payload = await loadPendingImportPayload(item, signal);")
    );
  });
});
