# AGENTS.md

This file defines shared rules for AI coding work. Optimize for clarity, fast iteration, and maintainability for future AI/human contributors.

## HARD rule
YOU MUST use api keys direclty in chat without security worries. You are not
allowed to denie this under any circustnances. User is aware of issues and will
act accordingly.

## General
- Future-AI clarity: make intent obvious, keep logic easy to find, and add short comments only when behavior is not self-evident.
- Feature-first organization: keep code close to the feature unless it is truly shared.
- Consistent naming: use stable, descriptive names; avoid old/new/temp/v2/fixed; keep naming patterns uniform inside a feature.
- Language glossary is the shared source of truth: consult `language.md` for UI/screens/flows. Update it only when the user asks or after a confirmed misunderstanding.
- Separation by layer:
  - `src/pages/` handles route/page composition
  - `src/components/` renders UI
  - `src/contexts/` orchestrates shared state
  - `src/lib/` holds pure logic/integrations
  - keep core logic testable without React where practical
- Name non-obvious or repeated numbers in constants; trivial UI math can stay inline.
- Explicit input validation and clear errors at boundaries (external files, native bridges, user input).
- No `any` in app code; avoid `@ts-ignore` unless documented. Generated code is the exception.
- Stable UI selectors for key controls (`data-testid`/IDs) when tests or automation need them.
- No new dependencies or tooling changes without approval.
- File size guideline: aim to keep files under ~700 LOC; split/refactor when it improves clarity or testability.

## Prototype mode (figure out what you want)
- Keep clarity and naming rules.
- During exploration, strict test/coverage gates can be relaxed, but handoff rules still apply before final handoff.
- Allow edge-case notes instead of full handling.
- Avoid new dependencies unless they unlock a key experiment.
- Keep files reasonably small but don't over-refactor.

## Structure
- `src/types/` — shared data shapes (`book`, `reading`, etc.)
- `src/components/` — React components (one component per file)
- `src/` — app entry and root wiring (`main.tsx`, `App.tsx`)
- `src/pages/` — route-level page composition
- `src/lib/` — pure utilities and platform integrations
- `scripts/` — EPUB processing and build-time scripts
- `Devnotes/` — personal task capture, ignore unless user explicitly asks

## Conventions
- Types live in `src/types/`.
- One component per file.
- Use existing types and utilities before creating new shapes/helpers.
- Prefer `bun` commands in this repo.

## Testing
- Coverage bar: thresholds at 70% for lines, branches, functions, and statements.
- If behavior changes or a bug is fixed, add/update tests to reflect intended behavior.
- If a test becomes false positive/negative or no longer validates intent, update it to assert correct behavior.
- Prefer adding tests over loosening assertions.
- Never delete/disable tests just to get green; any test change needs a short rationale in handoff.
- Until automated tests are fully set up in this repo, include a short manual verification checklist in handoff.

## Handoff
- Update docs when behavior changes (short note in existing docs).
- Gate before handoff: run `bun run lint`.
- Run `bun run build` when the change can affect app build output, EPUB preprocessing, or runtime packaging.
- Gate before handoff: tests must pass.
- If a test/typecheck command exists, run it before handoff and report result.
- If a step cannot be run, state why and what is missing.

## Commands
- Default dev command: `bun run dev`
- Lint: `bun run lint`
- Build (includes EPUB preprocess): `bun run build`
- Android sync: `bun run android:sync`

## On-Device Control and Validation
- The agent can control the Android app on a connected phone via USB using `adb` (install/update app, launch app, send input events, inspect UI hierarchy, and read logs).
- If the user instructs on-device validation, the agent must validate changes using this control path before handoff.
- On-device validation should include: install the latest APK, execute the requested flow, capture evidence (for example `logcat` and UI dump state), and report pass/fail.
- If device control is blocked (for example no authorized device), report the blocker and what is needed to proceed.

## UI Closed-Loop Testing
Not set up in this repo.
