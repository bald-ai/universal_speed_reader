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
- `src/app/` — Next.js pages and layout
- `scripts/` — EPUB processing
- `Devnotes/` — personal task capture, ignore unless user explicitly asks

## Conventions
- Types live in `src/types/`
- One component per file
- Use existing types, don't reinvent shapes

## Commands
- Use npm for this repo
- Default dev command: `npm run dev`

## UI Closed-Loop Testing
- Make UI changes
- Run `npm run screenshots` (or `npm run playwright` for the full suite)
- Review outputs in `test_screenshots/` and confirm the visual change
- Iterate by repeating the change → screenshots → review loop
- For agent-driven runs, a local runner/listener must be started in a terminal (so the agent can trigger tests over HTTP)
- Start the local runner in a terminal: `npm run runner:start`
- Runner default port: `7331` (override with `RUNNER_PORT` or `PORT`)
- Follow user instructions for testing flows exactly. Do not add extra screenshots or steps unless explicitly requested.
- Trigger screenshots over HTTP from another terminal:
  ```bash
  curl -s -X POST http://127.0.0.1:7331/run \
    -H 'content-type: application/json' \
    -d '{"task":"screenshots"}'
  ```
- Trigger the full Playwright suite over HTTP:
  ```bash
  curl -s -X POST http://127.0.0.1:7331/run \
    -H 'content-type: application/json' \
    -d '{"task":"playwright"}'
  ```
