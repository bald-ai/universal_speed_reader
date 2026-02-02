Prototype mode (figure out what you want)
- Keep clarity and naming rules.
- Skip strict test/coverage gates.
- Allow edge-case notes instead of full handling.
- Avoid new dependencies unless they unlock a key experiment.
- Keep files reasonably small but don't over-refactor.

## Structure
- `src/types/` — data shapes (Book, Chapter, Paragraph, Position, Mode)
- `src/components/` — React components
- `src/app/` — Next.js pages and layout
- `scripts/` — EPUB processing
- `DevNotes/` — personal task capture, ignore unless user explicitly asks

## Conventions
- Types live in `src/types/`
- One component per file
- Use existing types, don't reinvent shapes
