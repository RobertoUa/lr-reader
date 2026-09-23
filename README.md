# LR Reader

Offline EPUB/PDF reader for iPhone (PWA) with Language Reactor integration. See `PROMPT.md` for the spec.

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
   Chapter picker jumps; the Aa panel changes size, theme and font and keeps the current sentence on screen.
4. Back to library, reopen: same page. Kill the app from the app switcher, relaunch: same page.
5. Airplane mode on, kill and relaunch: library and book open and page normally.
6. Delete a book: gone from the list.

Words and Language Reactor:

1. Library > Settings: enter your Language Reactor email and token. On iPhone: Settings > Copy
   bookmarklet, save it as a Safari bookmark, tap it on languagereactor.com while logged in, Copy for
   LR Reader, then Settings > Paste Language Reactor login > Save. Footer error about Settings
   disappears.
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
2. Library > Prepare: pick a chapter range or a preset (This chapter, Next 5 chapters, To the end;
   From defaults to the chapter being read), optionally "Also make chapter summaries" (with the
   provider last used in the AI panel; they then open offline). The progress line counts chapters,
   sentences and words; Pause stops at once, and preparing again skips what is already cached. Words
   are looked up once per dictionary form. At the default 4 requests/second a 3,000-sentence book
   takes about 15 minutes; Language Reactor rate-limits a little above 5/s.
3. After a range is prepared, airplane mode: any word in it opens with its translation and the
   sentence translation. Play works only for words already played online.
4. Mark a word and save a phrase in airplane mode, even in a chapter never opened online: footer
   shows "2 to sync". Airplane mode off (or reopen the app): both sync. Tapping Learning again while
   it is still waiting (or while it is being sent) undoes it.

Bookmarks:

1. Reader > star button > Bookmark this page: the footer shows a star on that page. The list shows
   every bookmark with its chapter and text; tap one to jump there ("Back to where you were" returns).
   On a bookmarked page the button reads "Remove bookmark here".

Appearance:

1. Reader > Aa: text size, themes (Original, Paper, Calm, Focus, Quiet, Night), bold text, justify,
   line spacing, margins, fonts (Athelas, Charter, Georgia, Iowan, New York, Palatino, San Francisco,
   Seravek, Times). The page keeps the current sentence on screen; settings survive a relaunch
   without a flash of the default theme.

Speech:

1. Tap a word: it is spoken at once (Settings > "Say the word when I tap it" turns this off).
2. Sheet: Play (word or selected phrase), Play sentence. Language Reactor speaks only up to 30
   characters, so longer text always uses a device voice.
3. Settings > Voice: Language Reactor, or any Spanish iOS voice (works offline; download Enhanced or
   Premium voices in iOS Settings > Accessibility > Spoken Content > Voices). Speed 0.6x-1.2x.
   Test voice plays a sample.

Examples, search, page numbers:

1. Word sheet > Show examples: up to 5 other sentences from this book with the same form or its
   dictionary form, with translations; tap one to jump there (the sentence flashes blue), then
   "Back to where you were" returns to the sentence you were reading. Same after a search jump.
2. Reader > search button: accent- and case-insensitive search across the book; tap a result to jump.
3. Footer: chapter page (12/31), estimated book page (p. 57 of 412) and percent read.

Summaries:

1. Settings: a Claude and/or an OpenAI API key, and a model for each (keys stay on the device).
2. Reader > AI: pick "This page" or "This chapter" and the language, then "Summarize with Claude ..."
   or "Summarize with ChatGPT ..." (one button per key set): the text streams in; a summary made
   once opens again offline.
3. Without a key: Open in Claude / Open in ChatGPT open the chat with the request filled in (a
   chapter is too long for a link, so it is copied: paste it), Share... opens the iOS share sheet.

Offline English (for chapters not prepared):

1. Settings > Download offline English translation (about 110 MB, once). Status shows a test line.
2. Airplane mode, a chapter never prepared: tap a word: English gloss and the sentence in English,
   marked "Offline: English from the on-device model". Phrases too.

Translation source:

1. Settings > Translations from: ChatGPT (with an OpenAI key) or Claude (with a Claude key), model for
   each. Open an unprepared chapter: the page translates, words highlight by dictionary form, a tapped
   word shows glosses, More shows a dictionary entry; marking a word still saves to Language Reactor.
2. Without the chosen key: footer shows "Translations are set to ...: add its API key in Settings".
