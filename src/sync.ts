// Sync with the owner's Cloudflare Worker (sync/worker.js). State is a flat map of items; each device keeps
// the map it last synced (the base), so a three-way merge tells a local change from a remote one, including
// deletions, without timestamps. Books travel separately, once each.
import type { Book } from "./epub";

export type Items = Record<string, unknown>;
export type Conn = { url: string; token: string };

// Per item: unchanged on one side takes the other side; changed on both keeps the local value, except
// that an edit beats a deletion.
export function merge3(base: Items, local: Items, remote: Items): Items {
  const out: Items = {};
  const js = (x: unknown) => (x === undefined ? undefined : JSON.stringify(x));
  for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = js(base[k]), l = js(local[k]), r = js(remote[k]);
    const v = l === r || r === b ? local[k] : l === b ? remote[k] : local[k] ?? remote[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function call<T>(c: Conn, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(c.url.replace(/\/+$/, "") + path, { ...init, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" } });
  if (!r.ok && r.status !== 409) throw new Error(r.status === 401 ? "sync token rejected" : `sync server: HTTP ${r.status}`);
  return { status: r.status, body: await r.json() };
}

export const getState = async (c: Conn) => (await call<{ v: number; items?: Items }>(c, "/state")).body;
// Returns the new version, or the server's newer state when someone synced in between.
export async function putState(c: Conn, base: number, items: Items): Promise<{ v: number } | { conflict: { v: number; items?: Items } }> {
  const r = await call<{ v: number; items?: Items }>(c, `/state?base=${base}`, { method: "PUT", body: JSON.stringify({ items }) });
  return r.status === 409 ? { conflict: r.body } : { v: r.body.v };
}
export const listBooks = async (c: Conn) => (await call<string[]>(c, "/books")).body;
export const getBook = async (c: Conn, id: string) => (await call<Book | null>(c, `/book/${id}`)).body;
export const putBook = (c: Conn, id: string, b: Book) => call(c, `/book/${id}`, { method: "PUT", body: JSON.stringify(b) });
