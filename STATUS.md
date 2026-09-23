# LR Reader: status

Last updated: 2026-09-23. Live: https://robertoua.github.io/lr-reader/ (repo RobertoUa/lr-reader, every
push to `main` deploys). Spec: `PROMPT.md`. Manual test checklist: `README.md`.

## BLOCKER: Language Reactor refuses this app (found 2026-09-23 afternoon)

Language Reactor now answers this app's requests with decoy data instead of errors:

| Endpoint | State |
|---|---|
| `base_dict_fullDictTranslate_2` (sentence translation + NLP tokens) | Decoy: scrambled words, or the text "This app is reselling another service's data. Get the real thing free at languagereactor.com" |
| `base_dict_getFullDict_8` ("More") | Decoy (scrambled word, empty entries) |
| `base_dict_getHoverDict_8` (word translation) | Still real, probably CDN-cached |
| `base_dict_getDictTTS_3` (speech) | Still works |
| Items API (word list, save/remove) | Works (save, list, remove round trip after the block) |

This is Language Reactor stating it does not want third-party apps using its data. Most likely triggered
by the request volume from one machine during development (tests, "Prepare"). Do not try to get around
it; decide what the app should do instead (options below).

The app now treats a decoy translation as an error ("Language Reactor returned no translation ...")
instead of caching it. Translations cached before the block are real; any cached during the last
hours of 2026-09-23 may be decoys.

### Decision (2026-09-23): option 2, selectable

Settings > "Translations from": Language Reactor, ChatGPT (OpenAI key) or Claude (Claude key), with a
model per provider (defaults GPT-5.4 mini, Claude Opus 5). With an AI source, one request per batch of
sentences returns the translation plus each word's dictionary form, POS and glosses (cached as the
word lookups, so taps and Prepare need no per-word request); "More" asks the model for a dictionary
entry. Language Reactor is still used for the account: word list, highlighting, saving words and
phrases. Verified: Language Reactor accepts saved words whose context tokens were built by the app
(save, list, remove round trip).

### Options considered

1. Translations and dictionary from a provider the user pays for (OpenAI key already in Settings, or
   Claude): sentence translation, dictionary form and part of speech per word, glosses. Works for
   reading and highlighting. Saving words to Language Reactor still needs Language Reactor's own
   tokens for the context, so saved items would lose context or saving would stop.
2. Keep Language Reactor only for the user's own account (word list, saving) if the items API still
   works, with translations from option 1.
3. Read in Language Reactor's own apps instead.

## What works (tested in headless Chrome, on the live site in desktop Chrome; not yet on iPhone)

- PWA: installable, offline app shell, auto-update on next launch.
- Import EPUB (chapters from the TOC, including fragment splits) and PDF with a text layer (pdf.js;
  paragraphs rebuilt, running headers/page numbers dropped, chapters from bookmarks, bookmark titles
  found in the text, "Capitulo N" headings, 1-2-3 chapter numbers, else every 10 pages).
- Reader: CSS-column pagination, tap edges/swipe/arrow keys, chapter list, page in chapter and
  estimated page in book, position saved, Aa panel (6 themes, 9 fonts, size, bold, justify, spacing,
  margins), search (accent-insensitive), bookmarks with footer star, "Back to where you were" after a
  jump (hides on page turn or chapter change).
- Word sheet: translation, dictionary form, part of speech, sentence translation, More, Play, Play
  sentence, Show examples (5 sentences from the book with the same form or dictionary form).
- Phrases: long-press and drag, translation, Save phrase, Play.
- Highlighting of LEARNING words by dictionary form.
- Marks and phrases through an IndexedDB outbox: offline drafts completed at sync time, undo while
  queued or in flight, bound to the account they were made for, merge by entry id.
- Prepare for offline: chapter range and presets, pause/resume, rate-paced (default 4 req/s, pool of
  4), optional chapter summaries.
- Summaries: Claude (SDK) or ChatGPT (fetch) with the user's key; progress with elapsed seconds;
  saved summary shown when the panel opens; key-free Open in Claude / Open in ChatGPT / Share.
- Speech: Language Reactor voice for up to 30 characters, device voices otherwise or when chosen;
  speak on tap.
- Offline English fallback: opus-mt es-en in the browser (about 110 MB), runtime served from the app.
- Token bookmarklet for iPhone Safari and "Paste Language Reactor login" in Settings.

## QA in desktop Chrome on the live site (2026-09-23, translations from ChatGPT)

Passed: import, open, highlighting from the real word list (by dictionary form), page translation,
word sheet, More, Show examples, marking Learning (synced to the account) and undo (removed from the
account), phrase selection and translation, accent-insensitive search, jump with flash and "Back to
where you were", bookmarks (star, list, remove), Aa themes and fonts, ChatGPT summary with live
progress and the saved summary on reopen, Prepare of a whole book with chapter summaries.
Fixed after QA: the app reloaded onto a new version immediately, even mid-typing in Settings (now at
a safe moment); bookmark text was just the chapter heading (now the start of the page).

## Known limits and open items

- Offline English translation runs on the main thread (a short freeze on first use on iPhone).
- Offline drafts are keyed by the written form until they sync (handled, not re-keyed).
- Email/password login to fetch the token: not pursued (the account signs in with Google; the bookmarklet covers it).
- First AI translation of a page takes about 10 s with GPT-5.4 mini (one request for the whole page);
  a tap during that wait makes its own request for the sentence.
- No iPhone test yet: first-tap audio, Home Screen install, storage persistence.

## Credentials used in development

The Language Reactor token and an OpenAI key were pasted into the development chat and used in local
test commands. They are not in the repository. Rotate them if that is a concern.
