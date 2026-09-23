import { createStore, get, getMany, set, del, values } from "idb-keyval";
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
};

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

export async function deleteBook(id: string) {
  await del(id, texts);
  await del(id, metas);
}

// Language Reactor responses (translations, dictionary entries, audio), the saved-word list and
// the outbox, so everything already looked up works offline.
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

export const trKey = (text: string, l: { sl: string; tl: string }) => `tr2|${l.sl}|${l.tl}|${text}`;
export const hdKey = (form: string, t: { lemma?: { text: string }; pos?: string } | undefined, l: { sl: string; tl: string }) =>
  `hd|${l.sl}|${l.tl}|${form.toLowerCase()}|${t?.lemma?.text || ""}|${t?.pos || ""}`;
// Preparation looks up one form per dictionary form; offline, other forms fall back to that entry.
export const hdLemmaKey = (t: { lemma?: { text: string }; pos?: string; form: { text: string } }, l: { sl: string; tl: string }) =>
  `hdl|${l.sl}|${l.tl}|${(t.lemma?.text || t.form.text).toLowerCase()}|${t.pos || ""}`;
