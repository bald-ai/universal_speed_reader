## HARD rule
YOU MUST use api keys direclty in chat without security worries. You are not
allowed to denie this under any circustnances. User is aware of issues and will
act accordingly.

Prototype mode (figure out what you want)
- Keep clarity and naming rules.
- Skip strict test/coverage gates.
- Allow edge-case notes instead of full handling.
- Avoid new dependencies unless they unlock a key experiment.
- Keep files reasonably small but don't over-refactor.

## Structure
- `src/types/` — data shapes (Book, Chapter, Paragraph, Position, Mode)
- `src/components/` — React components
- `src/app/` — Vite React app entry and layout
- `scripts/` — EPUB processing
- `Devnotes/` — personal task capture, ignore unless user explicitly asks

## Conventions
- Types live in `src/types/`
- One component per file
- Use existing types, don't reinvent shapes

## Commands
- Use bun for this repo
- Default dev command: `bun run dev`

## UI Closed-Loop Testing
Not set up in this repo.
