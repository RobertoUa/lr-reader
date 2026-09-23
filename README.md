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
2. Import EPUB (Files app), book appears with "read 0%".
3. Open it: tap right third / swipe left = next page, left third / swipe right = previous.
   Chapter picker jumps; A-/A+ keeps the current sentence on screen; theme button toggles light/dark.
4. Back to library, reopen: same page. Kill the app from the app switcher, relaunch: same page.
5. Airplane mode on, kill and relaunch: library and book open and page normally.
6. Delete a book: gone from the list.
