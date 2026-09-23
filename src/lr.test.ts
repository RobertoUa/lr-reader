import { createHash } from "crypto";
import { expect, test } from "vitest";
import { bookRef, md5, phraseItem, wordItem, type Token } from "./lr";

const node = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

test("md5 matches node crypto", () => {
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "x".repeat(200), "\u00bfQu\u00e9 tal, se\u00f1or?", "\u00f1".repeat(64)]) {
    expect(md5(s)).toBe(node(s));
  }
  expect(md5("S\u00ed, quiz\u00e1s sea hoy el d\u00eda, por los pelos.").startsWith("f6e1b77296465d91")).toBe(true);
});

const tok = (text: string, lemma?: string, pos = "NOUN", diocoFreq: number | string = 100): Token =>
  text === " " ? { form: { text }, form_norm: { text }, pos: "WS", diocoFreq: "PUNCT_PLUS" } : { form: { text }, form_norm: { text: text.toLowerCase() }, lemma: { text: lemma || text.toLowerCase() }, pos, diocoFreq };
const nlp = [tok("Los", "el", "DET", 5), tok(" "), tok("gatos", "gato", "NOUN", 900), tok(" "), tok("comen", "comer", "VERB", 300), tok(".", ".", "PUNCT", "PUNCT_PLUS")];
const lang = { sl: "es", tl: "uk" };
const ctx = { text: "Los gatos comen.", tr: "Cats eat.", nlp, prev: "Antes.", next: null, ref: bookRef("book1", "Libro", "es", 7) };

test("word item", () => {
  expect(wordItem("gato", "LEARNING", 2, ctx, lang)).toEqual({
    itemType: "WORD", key: "WORD|gato|es", langCode_G: "es", translationLangCode_G: "uk", tags: [], wordTranslationsArr: null,
    wordType: "lemma", word: { text: "gato" }, freqRank: 900,
    context: {
      phrase: {
        subtitleTokens: { 0: null, 1: nlp, 2: null },
        subtitles: { 0: "Antes.", 1: "Los gatos comen.", 2: null },
        mTranslations: { 0: null, 1: "Cats eat.", 2: null },
        hTranslations: null,
        reference: { refVersion: 2, source: "USER_TEXT", url: null, diocoDocId: "ud_" + node("book1").slice(0, 12), diocoDocName: "Libro", diocoPlaylistId: "uu_all_es", diocoPlaylistName: "User Media", subtitleIndex: 7 },
        thumb_prev: null, thumb_next: null,
      },
      wordIndex: 2,
    },
    audio: null, learningStage: "LEARNING", reviewData: null, reviewHistory: null, timeModified_ms: 0, timeCreated_ms: 0, diocoFreq: 900, source: "USER_TEXT",
  });
});

test("phrase item", () => {
  const p = phraseItem("gatos comen", "cats eat", nlp.slice(2, 5), ctx, lang);
  expect(p.key).toBe("PHRASE-YT|es|" + node("gatos comen").slice(0, 16));
  expect(p.freqRank).toBe(600);
  expect(p.context.phrase.subtitles).toEqual({ 0: "Antes.", 1: "gatos comen", 2: null });
  expect(p.context.phrase.mTranslations).toEqual({ 0: null, 1: "cats eat", 2: null });
  expect(p.context.phrase.subtitleTokens[1]).toEqual(nlp.slice(2, 5));
  expect(p).toMatchObject({ itemType: "PHRASE", learningStage: "LEARNING", source: "USER_TEXT", audio: null });
});
