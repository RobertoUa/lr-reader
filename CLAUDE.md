# LR Reader

Offline EPUB/PDF reader for iPhone (PWA on the Home Screen) with Language Reactor integration. Static
site, no backend. Spec: `PROMPT.md`. Current state and decisions: `STATUS.md`. Manual test checklist:
`README.md`. Live: https://robertoua.github.io/lr-reader/ (every push to `main` deploys via
`.github/workflows/pages.yml`).

## Commands

- `npm run dev`: Vite dev server. `npm run build`: type-check (`tsc --noEmit`) + build to `dist/`.
- `npm test`: vitest (unit tests next to the code, `src/*.test.ts`).
- Before committing: `npx tsc --noEmit -p .`, `npm test`, `npm run build`, and the ASCII check
  `LC_ALL=C grep -nP '[^\x00-\x7F]' src/* index.html vite.config.ts` (must print nothing).
- Commit and push to `main` directly; the owner allowed it for this project. Watch the deploy with
  `gh run watch <id> -R RobertoUa/lr-reader --exit-status`.

## Code map (`src/`)

- `main.ts`: all UI and app state (library, reader, word sheet, phrases, panels, settings, outbox sync,
  summaries, study tools, backup, service worker registration). Large; sections are marked `// ---- X ----`.
- `lr.ts`: every Language Reactor call (unofficial API) plus item builders and MD5. Keep LR calls here only.
- `source.ts`: where translations/dictionary data come from (LR or AI); cache keys per source.
- `aitr.ts`: ChatGPT/Claude sentence translation + per-word lemma/POS/glosses, dictionary, synonyms.
- `ai.ts` (Claude SDK summaries), `summary.ts` (prompt, OpenAI summaries, key-free chat links).
- `epub.ts`, `pdf.ts` (pdf.js, lazy), `split.ts` (Intl.Segmenter sentences).
- `db.ts`: IndexedDB via idb-keyval: `lr-meta` (book metadata), `lr-text` (books), `lr-cache` (everything
  else, prefixed keys: `tr2|`/`tr3|`/`trx|` translations, `hd|`/`hdl|`/`fd|` dictionary, `syn|`, `mt|`,
  `tts|`, `sum|`/`sumlast|`, `wl|` word logs, `stats|`, `keys|` word list, `outbox`).
- `outbox.ts`: queued marks; `afterFlush` merges by entry id. `prepare.ts`: offline preparation (paced pool).
- `study.ts`: review scheduling, stats days, unknown-word density. `look.ts`: themes/fonts.
- `mt.ts` + `mt.worker.ts`: offline es->en model (transformers.js) in a Web Worker; onnxruntime served
  from the app, never from a CDN. `freq.ts` + `public/freq-es.txt`: word frequency (CC BY-SA, credited).
- `bookmarklet.js`: run on languagereactor.com to fetch the user's diocoToken; copied from Settings.

## Rules

- ASCII only in source, comments, docs and commits (data files like `public/freq-es.txt` excepted).
  Write non-ASCII in strings as `\uXXXX`; editors and heredocs have turned escapes into literal
  characters before, so run the ASCII check.
- Comments only for a non-obvious "why", one short line. No narration.
- Escape everything put into `innerHTML` with `esc()`; book text and API responses are untrusted.
- Secrets (LR token, API keys) live only in the user's localStorage. Never log them, never put them in
  URLs, the repo, or backups unless the user ticks the box.
- Language Reactor: it serves decoy data to this app for translation and the full dictionary (see
  STATUS.md). Do not try to get around that. Keep request volume low (tests included); the account API
  (word list, save/remove items) still works. TTS accepts at most 30 characters.
- Claude API code: follow the `claude-api` skill (default model `claude-opus-5`, don't downgrade for cost).
- Service worker: `registerType: autoUpdate`, `injectRegister: null`; `main.ts` registers `sw.js` and
  reloads only at a safe moment. Do not switch to prompt mode (strands existing installs).
- Performance matters on iPhone: chapters can have 20k word spans; avoid per-word work in `mark()` and
  layout reads in loops.

## Testing in a browser

- Headless Chrome via CDP is the reliable harness (`--dump-dom` does not run IndexedDB). A driver lives
  in `tmp/cdp.mjs` (gitignored); serve `dist/` under a subpath, e.g. copy to `tmp/site/lr-reader` and run
  `python3 -m http.server 4173` from `tmp/site`.
- The first load after a new build runs the previous build (service worker); load twice.
- Kill headless Chrome before deleting its profile, or IndexedDB gets corrupted.
- In the real Chrome (Claude in Chrome): don't type into password fields (password manager blocks the
  tools), set values via JS; override `window.confirm` before clicking buttons that confirm.
