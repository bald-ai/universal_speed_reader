import { describe, expect, it } from "bun:test";
import {
  createReaderToolbarScrollState,
  resetReaderToolbarScrollState,
  updateReaderToolbarScrollState,
} from "./readerToolbarVisibility";

describe("reader toolbar scroll visibility", () => {
  it("ignores small movement below the deliberate-scroll threshold", () => {
    let state = createReaderToolbarScrollState(100, 0);

    const first = updateReaderToolbarScrollState(state, 88, 40);
    state = first.state;
    const second = updateReaderToolbarScrollState(state, 76, 100);

    expect(first.intent).toBeNull();
    expect(second.intent).toBeNull();
    expect(second.state.distancePx).toBe(24);
  });

  it("expands after deliberate backward movement inside the time window", () => {
    let state = createReaderToolbarScrollState(120, 0);
    state = updateReaderToolbarScrollState(state, 98, 60).state;
    const update = updateReaderToolbarScrollState(state, 78, 140);

    expect(update.intent).toBe("backward");
    expect(update.state.distancePx).toBe(0);
  });

  it("collapses after the same amount of forward movement", () => {
    let state = createReaderToolbarScrollState(40, 0);
    state = updateReaderToolbarScrollState(state, 58, 60).state;
    const update = updateReaderToolbarScrollState(state, 80, 120);

    expect(update.intent).toBe("forward");
  });

  it("ignores a single large jump such as a virtualizer scroll correction", () => {
    let state = createReaderToolbarScrollState(1_000, 0);

    const jumpBack = updateReaderToolbarScrollState(state, 700, 30);
    expect(jumpBack.intent).toBeNull();

    state = createReaderToolbarScrollState(1_000, 0);
    const jumpForward = updateReaderToolbarScrollState(state, 1_300, 30);
    expect(jumpForward.intent).toBeNull();
  });

  it("still fires when a large first event is confirmed by a second one", () => {
    let state = createReaderToolbarScrollState(1_000, 0);
    state = updateReaderToolbarScrollState(state, 700, 30).state;
    const confirmed = updateReaderToolbarScrollState(state, 690, 90);

    expect(confirmed.intent).toBe("backward");
  });

  it("starts a new gesture window after a pause or direction change", () => {
    let state = createReaderToolbarScrollState(100, 0);
    state = updateReaderToolbarScrollState(state, 78, 40).state;

    const afterPause = updateReaderToolbarScrollState(state, 58, 400);
    expect(afterPause.intent).toBeNull();
    expect(afterPause.state.distancePx).toBe(20);

    const reversed = updateReaderToolbarScrollState(afterPause.state, 68, 430);
    expect(reversed.intent).toBeNull();
    expect(reversed.state.direction).toBe("forward");
    expect(reversed.state.distancePx).toBe(10);
  });

  it("can reset the baseline after programmatic scrolling", () => {
    const state = resetReaderToolbarScrollState(500, 1_000);
    const update = updateReaderToolbarScrollState(state, 510, 1_030);

    expect(update.intent).toBeNull();
    expect(update.state.distancePx).toBe(10);
  });
});
