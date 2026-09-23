import type { Book } from "./epub";
import { cacheGetMany, cacheSet, hdKey, trKey } from "./db";
import * as lr from "./lr";

export type Progress = { chapter: number; chapters: number; sentences: number; sentencesTotal: number; words: number; wordsSeen: number };

const WORD = /^[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*$/u;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

// Retries with backoff (the server answers RATE_LIMIT_EXCEEDED around 10 requests/s); a request that keeps failing stops preparation with its error.
async function retry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 3 || signal.aborted) throw e;
      await sleep(2000 * 4 ** i, signal);
    }
  }
}

// Caches every sentence translation and hover-dictionary entry, chapter by chapter. Everything
// already cached is skipped, so a stopped run resumes where it left off.
export async function prepareBook(book: Book, lang: lr.Lang, perSecond: number, signal: AbortSignal, progress: (p: Progress) => void) {
  const gap = 1000 / Math.max(0.2, perSecond);
  const sentencesTotal = book.chapters.reduce((n, c) => n + c.blocks.reduce((m, b) => m + b.sentences.length, 0), 0);
  const p: Progress = { chapter: 0, chapters: book.chapters.length, sentences: 0, sentencesTotal, words: 0, wordsSeen: 0 };
  const seen = new Set<string>();
  const request = async <T>(fn: () => Promise<T>) => {
    if (signal.aborted) throw new DOMException("Paused", "AbortError");
    const r = await retry(fn, signal);
    await sleep(gap, signal);
    return r;
  };

  for (const [ci, chapter] of book.chapters.entries()) {
    p.chapter = ci + 1;
    const sents = chapter.blocks.flatMap((b) => b.sentences);
    const trs = await cacheGetMany<lr.Translated>(sents.map((t) => trKey(t, lang)));
    p.sentences += trs.filter(Boolean).length;
    progress(p);
    let batch: number[] = [];
    let len = 0;
    const send = async () => {
      if (!batch.length) return;
      const texts = batch.map((i) => sents[i]);
      const res = await request(() => lr.translate(texts, lang));
      await Promise.all(res.map((r, k) => cacheSet(trKey(texts[k], lang), r)));
      batch.forEach((i, k) => (trs[i] = res[k]));
      p.sentences += batch.length;
      progress(p);
      batch = [];
      len = 0;
    };
    for (const [i, t] of sents.entries()) {
      if (trs[i]) continue;
      if (len + t.length + 2 > 500) await send();
      batch.push(i);
      len += t.length + 2;
    }
    await send();

    const words = new Map<string, [string, lr.Token]>();
    for (const tr of trs) {
      for (const t of tr!.nlp) {
        if (!WORD.test(t.form.text)) continue;
        const k = hdKey(t.form.text, t, lang);
        if (!seen.has(k)) words.set(k, [t.form.text, t]);
        seen.add(k);
      }
    }
    p.wordsSeen = seen.size;
    const keys = [...words.keys()];
    const hits = await cacheGetMany<string[]>(keys);
    p.words += hits.filter(Boolean).length;
    progress(p);
    for (const [i, k] of keys.entries()) {
      if (hits[i]) continue;
      const [form, t] = words.get(k)!;
      await cacheSet(k, await request(() => lr.hoverDict(form, t, lang)));
      p.words++;
      progress(p);
    }
  }
}
