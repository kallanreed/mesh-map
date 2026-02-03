# Repository Guidelines

## Project Structure & Module Organization
- Root HTML entry points live at the repo root (e.g., `index.html`, `wardrive.html`).
- Static assets, client scripts, and styles are in `content/` (images, CSS, JS, manifests).
- Cloudflare Pages Functions are in `functions/` (request handlers and utility endpoints).
- Tests are in `test/` (Vitest).
- Config and deployment settings are in `wrangler.jsonc`.
- Map UI (main app) is in `content/code.js`, with styling in `content/style.css`.

## Build, Test, and Development Commands
- `npm run dev` (or `npm start`): run Cloudflare Wrangler locally against this repo.
- `npm run deploy`: deploy Pages + Functions via Wrangler.
- `npm test`: run the Vitest suite.

## Coding Style & Naming Conventions
- JavaScript in `functions/` uses 2-space indentation, single quotes, and minimal semicolons.
- Prefer descriptive, action-oriented function names (`get-samples.js`, `put-sample.js`).
- Keep client assets in `content/` and reference them from root HTML files.
- `content/code.js` is plain JS (no Tailwind utility classes); prefer CSS updates in `content/style.css`.

## Testing Guidelines
- Framework: Vitest.
- Test files live in `test/` and use `*.test.js` naming (see `test/shared.test.js`).
- Add tests for shared logic used by both client and Functions, and for new API behaviors.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative sentences (e.g., "Fix consolidate query params").
- Avoid prefixes unless a feature branch requires it.
- PRs should include a clear description, testing notes, and screenshots for UI changes.

## Configuration & Environment
- Wrangler config is in `wrangler.jsonc`; D1 database binding is `DB`.
- Update bindings/config here when adding new data sources or environment settings.
- Leaderboard lookback uses `GET /get-senders?after=<epoch_ms>`; UI defaults to 10 days.
