# Build: LR Reader - offline EPUB reader for iPhone with Language Reactor integration

## Goal

I learn Spanish (source language `es`, my language `uk`). I want to read Spanish EPUB books on my
iPhone with Language Reactor style help, **fully offline** once a book is prepared:

- tap a word: translation popup (dictionary form, part of speech, more meanings, pronunciation);
- sentence translation, hidden until I ask for it;
- words from my Language Reactor list highlighted (LEARNING words orange);
- mark words as learning / known, and save a selected phrase; synced to my Language Reactor
  account when online, queued while offline.

Build it as a **web app (PWA)** added to the iPhone Home Screen. No App Store, no native code, no
backend of my own. Host as static files over HTTPS (GitHub Pages is fine).

## Reference implementation

`~/workspace/iina-lr-subs/overlay.html` is a working IINA plugin that already does most of the
Language Reactor side for subtitles: `translate()`, `dict()`, `say()`, `md5()`, `items()`,
`loadLiveWords()`, `wordItem()`, `phraseItem()`, `syncMark()`, plus the word-marking UI. Read it
first and reuse its logic; everything in the API section below was verified against my account
through that code.

## Platform constraints (iOS)

- Installed via Safari "Add to Home Screen" (standalone display mode, manifest, apple-touch-icon).
  Home Screen web apps keep their own storage and are not subject to Safari's 7-day eviction;
  still call `navigator.storage.persist()` and show `navigator.storage.estimate()` in Settings.
- Service worker precaches the app shell so the app opens in airplane mode.
- Books, prepared translations, dictionary entries and pronunciation audio live in IndexedDB.
- EPUB import through `<input type="file" accept=".epub,application/epub+zip">` (no File System
  Access API on iOS).
- Sentence splitting with `Intl.Segmenter` (granularity "sentence"), locale `es`.
- Touch UI: tap = word, long-press then drag = phrase selection. Big enough tap targets.

## Suggested stack

TypeScript + Vite, `vite-plugin-pwa` (Workbox) for the service worker, foliate-js (or epub.js)
for EPUB parsing and paginated rendering, a tiny IndexedDB wrapper (idb-keyval or `idb`). Keep
dependencies minimal; no UI framework unless it clearly pays for itself.

## Features

1. **Library**: import, list, delete books; per-book reading position; per-book "prepared %".
2. **Reader**: paginated, font size, light/dark, current chapter and progress.
3. **Word popup** (from cache when offline): the word, its dictionary form if different, quick
   translations, "more" (full entry by part of speech), "play" (cached TTS), and learning / known
   buttons. Clicking the active button clears it.
4. **Sentence translation**: hidden by default; tap a sentence (or a toggle button) to reveal it.
5. **Highlighting**: LEARNING words orange, matched by lemma (a conjugated form highlights through
   its dictionary form). Known words are not marked.
6. **Phrase save**: select several words, popup shows the exact selected text (punctuation
   included) with its translation, "save phrase" and "play". Saved as ONE phrase item, not as
   separate words.
7. **Prepare book** (online, once per book): see "Preparing a book". Progress bar, pause/resume,
   resumable after the app is closed, chapter by chapter.
8. **Sync**: my saved-words list loads when online and is cached for offline; marks and phrases go
   through an outbox (see "Sync").
9. **Settings**: Language Reactor email and token (password field), source / target language
   (`es` / `uk`), request throttle, storage usage, "export/import book data" (JSON) as a backup.

## Language Reactor API (unofficial, reverse-engineered, may change)

Keep every call in one module (`lr.ts`) so a change on their side is one fix. All responses are
JSON `{ status: "success" | "failure", data, error }`; treat anything but "success" as an error.
CORS allows any origin (`Access-Control-Allow-Origin: *`, `Content-Type` allowed), so the app calls
them directly with `fetch`.

Hosts: `DICT = https://api-cdn-plus.dioco.io/`, `ITEMS = https://api-cdn.dioco.io/`.

### No login needed

- `POST DICT/base_dict_fullDictTranslate_2`
  body `{"input":{"type":"TEXT","text":"<max 500 chars>"},"sl":"es","tl":"uk","mode":"NORMAL"}`
  -> `data.mTranslations: string[]` (one per input line) and `data.nlp: token[][]` (one token list
  per line). Tokens include whitespace tokens (`pos: "WS"`); a word token looks like
  `{form:{text}, form_norm:{text}, lemma:{text}, pos, xpos, feats, deprel, pointer, diocoFreq, freq}`.
  Check whether several sentences joined with "\n" in one request come back as separate entries
  in both arrays; if so, batch to cut the request count.
- `GET DICT/base_dict_getHoverDict_8?form=<lowercase word>&lemma=<lemma if different from form, else empty>&sl=es&tl=uk&pos=<POS or empty>&pow=n`
  -> `data.hoverDictEntries: string[]`. CDN-cached for a year.
- `GET DICT/base_dict_getFullDict_8?` same params
  -> `data.renderData.fullDictRenderData.entries: [{ word, posGroups: [{ pos, translations[] }] }]`.
- `GET DICT/base_dict_getDictTTS_3?lang=es&text=<text>` -> `data: "data:audio/mpeg;base64,..."`.
  Works for phrases too.

### Needs my account (`userEmail` + `diocoToken` in the JSON body)

The token is the `diocoToken` value the Language Reactor browser extension sends in its request
bodies. It gives access to my account: store it only locally, never log it, never put it in URLs.

- `POST ITEMS/base_items_getItemKeys_3 {userEmail, diocoToken}`
  -> `data.itemKeys.itemKeys[lang].WORD[stage][lemma]`, stage in `LEARNING | KNOWN | SKIPPED`.
  (`data.userRateLimits` is also returned; respect it.)
- `POST ITEMS/base_items_saveItem_5 {item, userEmail, diocoToken, initProposalReviewData: false}`
  (upsert by `item.key`, so retries are safe).
- `POST ITEMS/base_items_removeItem {itemKey, userEmail, diocoToken}`.
- `POST ITEMS/base_items_getItems_5` lists items (only needed for debugging).

### Item formats

Word:

```
{ itemType: "WORD", key: "WORD|<lemma lowercase>|es", langCode_G: "es", translationLangCode_G: "uk",
  tags: [], wordTranslationsArr: null, wordType: "lemma" (or "form" if the token has no lemma),
  word: { text: <lemma> }, freqRank: <token.diocoFreq if a number, else null>,
  context: { phrase: <Phrase>, wordIndex: <index of the word in phrase.subtitleTokens[1]> },
  audio: null, learningStage: "LEARNING" | "KNOWN", reviewData: null, reviewHistory: null,
  timeModified_ms: 0, timeCreated_ms: 0, diocoFreq: <token.diocoFreq or "NO_FREQ_DATA">, source: <ref.source> }
```

Phrase:

```
{ itemType: "PHRASE", key: "PHRASE-YT|es|" + md5(utf8(text)).slice(0, 16), langCode_G: "es",
  translationLangCode_G: "uk", context: { phrase: <Phrase> }, audio: null, learningStage: "LEARNING",
  tags: [], timeModified_ms: 0, timeCreated_ms: 0, reviewData: null, reviewHistory: null,
  freqRank: <average numeric diocoFreq of its tokens, or 20000>, source: <ref.source> }
```

Phrase (the context shared by both):

```
{ subtitleTokens: { 0: null, 1: <full NLP tokens of the sentence>, 2: null },
  subtitles: { 0: <previous sentence or null>, 1: <sentence or saved phrase text>, 2: <next sentence or null> },
  mTranslations: { 0: null, 1: <translation>, 2: null } or null, hTranslations: null,
  reference: <Reference>, thumb_prev: null, thumb_next: null }
```

Verified pitfalls, do not rediscover them:

- A word saved with `context: null` is stored but does NOT appear on the Saved Items page. Always
  send the sentence as context.
- With context, `subtitleTokens[1]` must be the FULL NLP tokens from `fullDictTranslate_2` for that
  sentence, and `wordIndex` counts over that array including whitespace tokens. Minimal
  `{form, form_norm}` tokens are rejected with `BAD_REQUEST`. So a word can only be saved once
  its sentence has been through the translate call (cache it during preparation).
- The phrase key must be MD5 of the UTF-8 text. WebCrypto has no MD5: use a small JS MD5 (the one
  in the reference implementation). Check: `md5("S\u00ed, quiz\u00e1s sea hoy el d\u00eda, por los pelos.")`
  starts with `f6e1b77296465d91`.

Reference: Language Reactor's own text/book reader saves with

```
{ refVersion: 2, source: "USER_TEXT", url: null, diocoDocId: "ud_<12 hex>", diocoDocName: <title>,
  diocoPlaylistId: "uu_all_es", diocoPlaylistName: "User Media", subtitleIndex: <sentence index> }
```

where `ud_...` is the id their server gives an uploaded document. Try this with a made-up stable id
(for example `"ud_" + md5(bookId).slice(0, 12)`). If the server rejects it, fall back to
`{ refVersion: 2, source: "CHAT", diocoDocId: null, diocoDocName: null, diocoPlaylistId: null, diocoPlaylistName: null, subtitleIndex: <index> }`,
which needs no document. Decide with a real test: save a test word and a test phrase, confirm they
come back from `getItems_5` (query with `searchText`, `itemType`, `langCode_G: "es"`,
`learningStages: ["LEARNING","KNOWN"]`, `orderBy: "NEXT_REVIEW_DESC"`), then delete them.

## Preparing a book (online, once)

1. Split every chapter into sentences with `Intl.Segmenter`; store them with stable ids.
2. Translate sentences (batched if the "\n" check works, otherwise one per request), storing
   `mTranslations` and the full NLP tokens per sentence.
3. Collect distinct (form, lemma, pos) from the tokens; fetch `getHoverDict_8` for each; fetch
   `getFullDict_8` lazily or for LEARNING words only; optionally pre-fetch TTS for LEARNING words.
4. Throttle (default about 2 requests/second, configurable), retry with backoff, stop on repeated
   failures, resume from where it stopped. Show counts: sentences done/total, words done/total.
   A novel is about 6,000 sentences and 5,000-8,000 distinct words, so expect it to take a while
   and make it run chapter by chapter.

## Sync

- Word list: on app open and when coming online, call `getItemKeys_3` and cache the result; offline,
  use the cached list plus pending local marks.
- Outbox in IndexedDB: `{ id, op: "save" | "remove", item | itemKey, createdAt, attempts }`. Marking
  a word applies it to the UI immediately and adds an outbox entry. Flush on app open, on the
  `online` event, and after each new entry while online. Remove entries on success; keep them with
  a visible error count on failure.
- Removing a word only needs a server call if it is in the synced list.

## Quality bar

- Unit tests: MD5 (against Node's crypto on ASCII, multi-block and Spanish text, plus the key
  above), word/phrase item builders (fixture comparison), outbox behavior, sentence splitting.
- A manual checklist that includes airplane mode: open the app, open a prepared book, word popup,
  sentence translation, pronunciation, marking a word offline, coming back online and seeing it
  sync, and the word appearing on languagereactor.com Saved Items.
- Fail visibly: every Language Reactor error surfaces in the UI with its message; nothing fails
  silently.
- ASCII-only source and comments; comments only for non-obvious "why".

## Milestones

1. PWA shell, EPUB import, reader, works in airplane mode.
2. Book preparation, sentence translation, word popup from cache.
3. Settings, live word list and highlighting, marking with outbox sync, phrase saving (after the
   reference test above decides USER_TEXT vs CHAT).
4. Polish: storage view, export/import of book data, reading stats.

Stop after each milestone, show me how to test it on the iPhone, and wait for my go-ahead.
