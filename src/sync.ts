// Sync with the owner's Cloudflare Worker (sync/worker.js). State is a flat map of items; each device keeps
// the map it last synced (the base), so a three-way merge tells a local change from a remote one, including
// deletions, without timestamps. Books travel separately, once each.
import type { Book } from "./epub";

export type Items = Record<string, unknown>;
export type Conn = { url: string; token: string };

// Counters (reading stats per day, lookup counts) grow on every device, so both sides' increments add up.
const COUNTERS = ["stats|", "looks|"];
type Counter = number | Record<string, number>;
function addUp(b: Counter | undefined, l: Counter, r: Counter, firstSync: boolean): Counter {
  const f = (x: number | undefined, y: number | undefined, z: number | undefined) => (firstSync ? Math.max(y || 0, z || 0) : (y || 0) + (z || 0) - (x || 0));
  if (typeof l === "number") return f(b as number | undefined, l, r as number);
  const o = b as Record<string, number> | undefined, rr = r as Record<string, number>;
  return Object.fromEntries([...new Set([...Object.keys(l), ...Object.keys(rr)])].map((k) => [k, f(o?.[k], l[k], rr[k])]));
}

// Per item: unchanged on one side takes the other side; changed on both keeps the local value (the remote
// one when preferRemote, for a device's first sync), except that an edit beats a deletion and counters add up.
export function merge3(base: Items, local: Items, remote: Items, preferRemote = false): Items {
  const out: Items = {};
  const js = (x: unknown) => (x === undefined ? undefined : JSON.stringify(x));
  for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = js(base[k]), l = js(local[k]), r = js(remote[k]);
    const both = local[k] !== undefined && remote[k] !== undefined && COUNTERS.some((p) => k.startsWith(p));
    const v = l === r || r === b ? local[k] : l === b ? remote[k]
      : both ? addUp(base[k] as Counter | undefined, local[k] as Counter, remote[k] as Counter, preferRemote)
      : preferRemote ? remote[k] ?? local[k] : local[k] ?? remote[k];
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
