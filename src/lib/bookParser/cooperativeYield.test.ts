import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createCooperativeYielder } from "./cooperativeYield";

describe("createCooperativeYielder", () => {
  afterEach(() => {
    // Spies restored per-test.
  });

  it("does not yield while under the time budget", async () => {
    let now = 1_000;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => now);
    const originalChannel = globalThis.MessageChannel;
    let channelConstructed = 0;
    globalThis.MessageChannel = class {
      constructor() {
        channelConstructed += 1;
        throw new Error("MessageChannel should not be used under budget");
      }
    } as unknown as typeof MessageChannel;

    try {
      const maybeYield = createCooperativeYielder(50);
      await maybeYield();
      now += 49;
      await maybeYield();
      expect(channelConstructed).toBe(0);
    } finally {
      nowSpy.mockRestore();
      globalThis.MessageChannel = originalChannel;
    }
  });

  it("yields once past the time budget", async () => {
    let now = 1_000;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => now);
    const originalChannel = globalThis.MessageChannel;
    let posted = 0;
    globalThis.MessageChannel = class {
      port1: { onmessage: ((event: MessageEvent) => void) | null; close: () => void };
      port2: { postMessage: () => void };
      constructor() {
        const port1 = {
          onmessage: null as ((event: MessageEvent) => void) | null,
          close() {
            /* no-op */
          },
        };
        this.port1 = port1;
        this.port2 = {
          postMessage() {
            posted += 1;
            queueMicrotask(() => {
              port1.onmessage?.({ data: null } as MessageEvent);
            });
          },
        };
      }
    } as unknown as typeof MessageChannel;

    try {
      const maybeYield = createCooperativeYielder(50);
      await maybeYield();
      expect(posted).toBe(0);

      now += 51;
      await maybeYield();
      expect(posted).toBe(1);

      // Still under budget after the yield reset.
      now += 10;
      await maybeYield();
      expect(posted).toBe(1);
    } finally {
      nowSpy.mockRestore();
      globalThis.MessageChannel = originalChannel;
    }
  });
});
