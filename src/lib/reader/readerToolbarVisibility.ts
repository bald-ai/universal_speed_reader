export const READER_TOOLBAR_SCROLL_THRESHOLD_PX = 40;
export const READER_TOOLBAR_SCROLL_WINDOW_MS = 220;
// A single scroll event can be a programmatic jump (virtualizer row
// re-measurement, scrollIntoView); only a sequence of same-direction events
// counts as a human gesture.
export const READER_TOOLBAR_SCROLL_MIN_EVENTS = 2;

export type ReaderToolbarScrollDirection = "backward" | "forward";

export type ReaderToolbarScrollState = {
  lastScrollTop: number | null;
  direction: ReaderToolbarScrollDirection | null;
  distancePx: number;
  eventsInWindow: number;
  windowStartedAtMs: number;
};

export type ReaderToolbarScrollUpdate = {
  state: ReaderToolbarScrollState;
  intent: ReaderToolbarScrollDirection | null;
};

export function createReaderToolbarScrollState(
  scrollTop: number | null = null,
  nowMs = 0,
): ReaderToolbarScrollState {
  return {
    lastScrollTop: scrollTop,
    direction: null,
    distancePx: 0,
    eventsInWindow: 0,
    windowStartedAtMs: nowMs,
  };
}

export function resetReaderToolbarScrollState(
  scrollTop: number,
  nowMs: number,
): ReaderToolbarScrollState {
  return createReaderToolbarScrollState(scrollTop, nowMs);
}

/**
 * Converts scroll movement into deliberate reading-direction intent.
 * Increasing scrollTop means reading forward; decreasing means returning to
 * earlier text. Small movement is accumulated only inside a short window so
 * touch jitter cannot toggle the toolbar.
 */
export function updateReaderToolbarScrollState(
  current: ReaderToolbarScrollState,
  scrollTop: number,
  nowMs: number,
  thresholdPx = READER_TOOLBAR_SCROLL_THRESHOLD_PX,
  windowMs = READER_TOOLBAR_SCROLL_WINDOW_MS,
): ReaderToolbarScrollUpdate {
  if (current.lastScrollTop === null) {
    return {
      state: resetReaderToolbarScrollState(scrollTop, nowMs),
      intent: null,
    };
  }

  const delta = scrollTop - current.lastScrollTop;
  if (delta === 0) {
    return {
      state: { ...current, lastScrollTop: scrollTop },
      intent: null,
    };
  }

  const direction: ReaderToolbarScrollDirection = delta < 0 ? "backward" : "forward";
  const continuesWindow = current.direction === direction
    && nowMs - current.windowStartedAtMs <= windowMs;
  const distancePx = (continuesWindow ? current.distancePx : 0) + Math.abs(delta);
  const eventsInWindow = (continuesWindow ? current.eventsInWindow : 0) + 1;
  const windowStartedAtMs = continuesWindow ? current.windowStartedAtMs : nowMs;

  if (distancePx < thresholdPx || eventsInWindow < READER_TOOLBAR_SCROLL_MIN_EVENTS) {
    return {
      state: {
        lastScrollTop: scrollTop,
        direction,
        distancePx,
        eventsInWindow,
        windowStartedAtMs,
      },
      intent: null,
    };
  }

  return {
    state: {
      lastScrollTop: scrollTop,
      direction,
      distancePx: 0,
      eventsInWindow: 0,
      windowStartedAtMs: nowMs,
    },
    intent: direction,
  };
}
