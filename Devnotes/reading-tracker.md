# Reading Tracker (Daily/Weekly Stats)

**Status:** Planned  
**Priority:** v2 — after initial APK ship  
**Effort:** ~half day

## What

A simple tracker showing how much the user reads over time. Not gamification — just a quiet, motivating signal.

## Display

- Daily reading time (minutes)
- Weekly summary (total time + days active)
- Simple visual — 7-day bar chart or dot streak on the home screen

## Technical Approach

### Already have
- `reading_progress` table with `updated_at` timestamps per book
- Paragraph + word position tracked (can compute words read)
- Progress flushed on visibility change (natural session boundary)

### Need to add
1. **`reading_sessions` table** — `book_id`, `started_at`, `ended_at`, `words_read`
2. **Session logger** — hook into existing progress saves in `ReadingContext`; open session on reader enter, close on exit/visibility-hidden
3. **Stats UI** — small card on home screen showing daily/weekly aggregates

### Key decisions
- Keep it local-only (no sync/cloud)
- Don't overcomplicate — minutes read + days active is enough
- Aggregate queries stay in SQLite
