import type { Book } from "./epub";
import { cacheGetMany, cacheSet, hdKey, hdLemmaKey } from "./db";
import * as S from "./source";
import * as lr from "./lr";

export type Progress = { chapter: number; chapters: number; sentences: number; sentencesTotal: number; words: number; wordsSeen: number };

const WORD = /^[\p{L}\p{M}\p{N}]+(?:['\u2019-][\p{L}\p{M}\p{N}]+)*$/u;
const PARALLEL = 4;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

// Spaces requests at the target rate with a few in flight, since each reply takes 0.3-0.8 s.
// The server answers RATE_LIMIT_EXCEEDED a little above 5 requests/s: then halve the rate, wait, and creep back up.
function pacer(max: number, signal: AbortSignal) {
  let rate = max;
  let next = 0;
  let ok = 0;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new DOMException("Paused", "AbortError");
      const now = Date.now();
      const at = Math.max(now, next);
      next = at + 1000 / rate;
      await sleep(at - now, signal);
      if (signal.aborted) throw new DOMException("Paused", "AbortError");
      try {
        const r = await fn();
        if (++ok % 25 === 0) rate = Math.min(max, rate + 0.5);
        return r;
      } catch (e) {
        const limited = /RATE_LIMIT/.test((e as Error).message);
        if (limited) rate = Math.max(0.5, rate / 2);
        if (attempt === (limited ? 6 : 3) || signal.aborted) throw e;
        await sleep(limited ? 10000 : 2000 * 4 ** attempt, signal);
      }
    }
  };
}

// Stops handing out items on the first failure, so the other workers do not carry on after it.
async function pool<T>(items: T[], work: (x: T) => Promise<void>) {
  let i = 0, failed = false;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (!failed && i < items.length) {
        try {
          await work(items[i++]);
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    }),
  );
}

export const chapterSentences = (book: Book) => book.chapters.map((c) => c.blocks.reduce((m, b) => m + b.sentences.length, 0));

// Caches every sentence translation and hover-dictionary entry of the given chapters, one chapter at a
// time. Everything already cached is skipped, so a stopped run resumes where it left off.
export async function prepareBook(book: Book, chapters: number[], src: S.Source, lang: lr.Lang, perSecond: number, signal: AbortSignal, progress: (p: Progress) => void, done: (chapter: number) => Promise<void>) {
  const request = pacer(Math.max(0.5, perSecond), signal);
  const counts = chapterSentences(book);
  const sentencesTotal = chapters.reduce((n, ci) => n + counts[ci], 0);
  const p: Progress = { chapter: 0, chapters: chapters.length, sentences: 0, sentencesTotal, words: 0, wordsSeen: 0 };
  const seen = new Set<string>();

  for (const ci of chapters) {
    p.chapter++;
    const sents = book.chapters[ci].blocks.flatMap((b) => b.sentences);
    const trs = await cacheGetMany<lr.Translated>(sents.map((t) => S.trKey(src, t, lang)));
    p.sentences += trs.filter(Boolean).length;
    progress(p);

    const batches: number[][] = [];
    let len = src.batchChars;
    for (const [i, t] of sents.entries()) {
      if (trs[i]) continue;
      if (len + t.length + 2 > src.batchChars) batches.push([]), (len = 0);
      batches[batches.length - 1].push(i);
      len += t.length + 2;
    }
    await pool(batches, async (batch) => {
      const texts = batch.map((i) => sents[i]);
      const res = await S.translate(src, texts, lang, request);
      await Promise.all(res.map((r, k) => cacheSet(S.trKey(src, texts[k], lang), r)));
      batch.forEach((i, k) => (trs[i] = res[k]));
      p.sentences += batch.length;
      progress(p);
    });

    const words = new Map<string, [string, lr.Token]>();
    for (const tr of trs) {
      for (const t of tr!.nlp) {
        if (!WORD.test(t.form.text)) continue;
        const k = hdLemmaKey(t, lang);
        if (!seen.has(k)) words.set(k, [t.form.text, t]);
        seen.add(k);
      }
    }
    p.wordsSeen = seen.size;
    const keys = [...words.keys()];
    // AI sources return word glosses with the sentences, already cached under these keys.
    const hits = await cacheGetMany<string[]>(keys);
    p.words += hits.filter(Boolean).length;
    progress(p);
    await pool(src.ai ? [] : keys.filter((_, i) => !hits[i]), async (k) => {
      const [form, t] = words.get(k)!;
      const entries = await request(() => lr.hoverDict(form, t, lang));
      await Promise.all([cacheSet(k, entries), cacheSet(hdKey(form, t, lang), entries)]);
      p.words++;
      progress(p);
    });
    await done(ci);
  }
}
