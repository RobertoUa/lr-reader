import { createStore, get, set, del, values } from "idb-keyval";
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
