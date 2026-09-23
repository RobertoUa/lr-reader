import { createStore, get, getMany, set, setMany, del, delMany, keys, values } from "idb-keyval";
import type { Book } from "./epub";

export type Pos = { ch: number; s: number };
export type Meta = {
  id: string;
  title: string;
  author: string;
  added: number;
  sentences: number;
  pos: Pos;
  // Sentences before pos across the whole book, for the progress figure in the library.
  done: number;
  prepared: number;
  preparedChapters?: number[];
  bookmarks?: Bookmark[];
};
export type Bookmark = { ch: number; s: number; text: string; at: number };

// idb-keyval keeps one object store per database, so metadata and text get a database each;
// the library lists metadata without loading whole books.
const metas = createStore("lr-meta", "kv");
const texts = createStore("lr-text", "kv");

export const listBooks = async () => (await values<Meta>(metas)).sort((a, b) => b.added - a.added);
export const getMeta = (id: string) => get<Meta>(id, metas);
export const putMeta = (m: Meta) => set(m.id, m, metas);
export const getBook = (id: string) => get<Book>(id, texts);

export async function addBook(book: Book): Promise<Meta> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const sentences = book.chapters.reduce((n, c) => n + c.blocks.reduce((m, b) => m + b.sentences.length, 0), 0);
  const meta: Meta = { id, title: book.title, author: book.author, added: Date.now(), sentences, pos: { ch: 0, s: 0 }, done: 0, prepared: 0 };
  await set(id, book, texts);
  await putMeta(meta);
  return meta;
}

// Also drops the book's cached sentence translations; dictionary entries and summaries are shared or small.
export async function deleteBook(id: string, lang: { sl: string; tl: string }) {
  const book = await getBook(id);
  await Promise.all([
    book && delMany(book.chapters.flatMap((c) => c.blocks.flatMap((b) => b.sentences)).map((t) => trKey(t, lang)), cache),
    del(id, texts),
    del(id, metas),
  ]);
}

// Language Reactor responses (translations, dictionary entries, audio), the saved-word list, the
// outbox, AI summaries (sum|) and offline English translations (mt|), so what was looked up works offline.
const cache = createStore("lr-cache", "kv");
export const cacheGet = <T>(k: string) => get<T>(k, cache);
export const cacheGetMany = <T>(ks: string[]) => getMany<T>(ks, cache);
export const cacheSet = (k: string, v: unknown) => set(k, v, cache);

export async function cached<T>(k: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(k);
  if (hit !== undefined) return hit;
  const v = await fetcher();
  await cacheSet(k, v);
  return v;
}

// Sentences over 500 characters were once cached cut off at 500; a new prefix for them skips those entries.
export const trKey = (text: string, l: { sl: string; tl: string }) => `${text.length > 500 ? "tr3" : "tr2"}|${l.sl}|${l.tl}|${text}`;
export const hdKey = (form: string, t: { lemma?: { text: string }; pos?: string } | undefined, l: { sl: string; tl: string }) =>
  `hd|${l.sl}|${l.tl}|${form.toLowerCase()}|${t?.lemma?.text || ""}|${t?.pos || ""}`;
// Preparation looks up one form per dictionary form; offline, other forms fall back to that entry.
export const hdLemmaKey = (t: { lemma?: { text: string }; pos?: string; form: { text: string } }, l: { sl: string; tl: string }) =>
  `hdl|${l.sl}|${l.tl}|${(t.lemma?.text || t.form.text).toLowerCase()}|${t.pos || ""}`;

// Translations, word glosses, dictionary entries and offline English results; summaries, the saved-word
// list and the outbox stay.
export async function clearTranslations(): Promise<number> {
  const drop = (await keys<string>(cache)).filter((k) => /^(tr2|tr3|trx|hd|hdl|fd|mt|syn)\|/.test(String(k)));
  await delMany(drop, cache);
  return drop.length;
}

// Words marked per book (wl|<bookId>), reading stats per day (stats|<date>): kept by Clear translation cache.
export const getCacheByPrefix = async <T>(prefix: string): Promise<[string, T][]> => {
  const ks = (await keys<string>(cache)).map(String).filter((k) => k.startsWith(prefix));
  const vs = await getMany<T>(ks, cache);
  return ks.map((k, i) => [k, vs[i] as T]);
};
export const setCacheMany = (entries: [string, unknown][]) => setMany(entries, cache);
export const putBook = async (m: Meta, book: Book) => {
  await set(m.id, book, texts);
  await putMeta(m);
};
