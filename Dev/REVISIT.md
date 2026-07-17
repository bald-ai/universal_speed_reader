# Revisit

Parking lot for improvements, open questions, and polish that is not worth doing now.

---

## Navigation separators — parts, hierarchy, and noisy starts

**Seen:** Monte Cristo TOC → opening prose showed a **part** separator (two diamonds). Chapter separators use one.

**Open questions**
- Do parts need their own separator at all, or is chapter-only enough?
- Worth a pass over the full separator hierarchy (part / chapter / section / scene): when each shows, how they stack, and whether they duplicate.
- Separators sometimes appear at the very start of a book where they clearly do not make sense.

**Severity note:** Start-of-book noise is the least harmful place for this. Decide later whether cleanup is worth the time.

---

## Batch import: gated read-ahead (reclaim serialized-read time)

**Context:** The import package (`Dev/PLAN-import-safe-pipeline-wins.md`, item H) fully
serializes batch file reads with parsing: the next book's file is read only after the
previous book finishes. This fixed "works solo, fails in batch" (reads and buffered
bytes were stealing wall-clock time from the parser's 30s budget) at the cost of
~1–3 s of non-overlapped read time per book.

**Better approach if batch wall time ever matters:** gated overlap — allow reading
the *next* file while the parser is busy, but make the read cooperative: pause or
chunk it whenever the parser is mid-book, cap buffered bytes at one book, and hand
off the moment the parser goes idle. Keeps most of the pipeline speed while
preserving solo-equivalent parse conditions.

**Why deferred:** more states to get right (pause/resume, cancel mid-read, abort
races) for a saving that is small next to 30 s parses. Only worth it with evidence
that serialized reads add meaningful time on real folders.

---

## Background import while app is minimized / unfocused

**Not top priority now.** Current product direction is a foreground import session: keep the app open, screen stays awake, Library locked until the batch finishes or Cancel — predictability over continuing while the user leaves.

**Seen (investigation):** Batch work only continues across in-app navigation accidentally (JS singleton in the same WebView). Minimized / screen-off / process death has no real contract: no WorkManager, foreground service, notification, or queue rehydrate on relaunch. Books can stick in active phases after kill.

**If revisited later — what “real” background needs**
- Native staging of selected sources + durable queue records.
- Parser/commit path that does not depend on a live WebView (ported native/Kotlin work via WorkManager, or equivalent).
- Per-book checkpointing; ongoing notification + Cancel; startup reconciliation after death/reboot.
- Honest split: a persisted JS queue + Web Worker only resumes after relaunch — it does **not** keep importing while Android suspends the app.

**Defer:** Stages for route-global / persisted JS import, and full native background import. Do not half-ship a notification around today’s JS queue and call it background.
