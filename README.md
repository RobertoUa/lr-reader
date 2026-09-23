# LR Reader

Offline EPUB reader for iPhone (PWA) with Language Reactor integration. See `PROMPT.md` for the spec.

    npm install
    npm run dev      # local dev server
    npm test         # unit tests
    npm run build    # static site in dist/

Pushing to `main` deploys to GitHub Pages (`.github/workflows/pages.yml`; set Settings > Pages >
Source to "GitHub Actions" once).

## Manual checklist (iPhone)

Milestone 1:

1. Open the Pages URL in Safari, Share > Add to Home Screen, launch from the icon (no Safari bars).
2. Import book (Files app), EPUB or PDF, appears with "read 0%". A PDF needs a text layer; its
   chapters come from bookmarks, "Capitulo N" headings or chapter numbers, else every 10 pages.
3. Open it: tap right third / swipe left = next page, left third / swipe right = previous.
   Chapter picker jumps; A-/A+ keeps the current sentence on screen; theme button toggles light/dark.
4. Back to library, reopen: same page. Kill the app from the app switcher, relaunch: same page.
5. Airplane mode on, kill and relaunch: library and book open and page normally.
6. Delete a book: gone from the list.

Words and Language Reactor:

1. Library > Settings: enter your Language Reactor email and token (the `diocoToken` the browser
   extension sends in its request bodies). Footer error about Settings disappears.
2. Open a book: words from your LR list at stage LEARNING are orange, including conjugated forms
   (they match through the dictionary form once the page has been translated, a second or so).
3. Tap a word: sheet shows the word, dictionary form and part of speech, translations, the sentence
   and its translation. More = full dictionary entry, Play = pronunciation.
4. Learning: the word turns orange, footer shows "1 to sync" briefly, then nothing. Check it on
   languagereactor.com Saved Items. Tap Learning again: it is removed there too.
5. Airplane mode: tap a word you tapped before: same sheet from cache. Mark a word: footer shows
   "1 to sync". Airplane mode off: it syncs and appears on Saved Items.

Phrases and offline preparation:

1. Long-press a word (about half a second), drag across more words, release: they turn blue and the
   sheet shows the exact text with punctuation and its translation. Save phrase: appears on Saved
   Items as one phrase. Play reads it.
2. Library > Prepare: pick a chapter range (default: current chapter to the end); progress line counts chapters, sentences and words; Pause stops at once and
   Prepare resumes where it stopped (also after closing the app). It starts with the chapter being
   read and looks words up once per dictionary form. At the default 4 requests/second a 3,000-sentence
   book takes about 15 minutes; Language Reactor rate-limits a little above 5/s.
4. Mark a word and save a phrase in airplane mode, even in a chapter never opened online: footer
   shows "2 to sync". Airplane mode off (or reopen the app): both sync.
3. After it reaches 100%, airplane mode: any word in the book opens with its translation and the
   sentence translation. Play works only for words already played online.

Appearance:

1. Reader > Aa: text size, themes (Original, Paper, Calm, Focus, Quiet, Night), bold text, justify,
   line spacing, margins, fonts (Athelas, Charter, Georgia, Iowan, New York, Palatino, San Francisco,
   Seravek, Times). The page keeps the current sentence on screen; settings survive a relaunch
   without a flash of the default theme.

Speech:

1. Tap a word: it is spoken at once (Settings > "Say the word when I tap it" turns this off).
2. Sheet: Play (word or selected phrase), Play sentence.
3. Settings > Voice: Language Reactor, or any Spanish iOS voice (works offline; download Enhanced or
   Premium voices in iOS Settings > Accessibility > Spoken Content > Voices). Speed 0.6x-1.2x.
   Test voice plays a sample.

Examples, search, page numbers:

1. Word sheet > Show examples: up to 5 other sentences from this book with the same form or its
   dictionary form, with translations; tap one to jump there (the sentence flashes blue).
2. Reader > search button: accent- and case-insensitive search across the book; tap a result to jump.
3. Footer: chapter page (12/31), estimated book page (p. 57 of 412) and percent read.
