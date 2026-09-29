// LR Reader sync: one user's reading state and books, behind a bearer token (secret TOKEN).
// GET/PUT /state (PUT needs ?base=<version it merged from>, 409 with the current state if that is stale),
// GET /books (ids), GET/PUT /book/<id>.
// State lives in a Durable Object: KV reads can be stale for a minute, which breaks the version check.
// Books stay in KV since each is written once.
import { DurableObject } from "cloudflare:workers";

const ORIGINS = ["https://robertoua.github.io", "capacitor://localhost", "http://localhost:5173", "http://127.0.0.1:4173"];

export class State extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS items (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
      // One-time move from the KV-only version.
      if (!this.version()) {
        const old = await env.KV.get("state", "json");
        if (old?.v) this.save(old.v, {}, old.items || {});
      }
    });
  }
  version() {
    return this.sql.exec("SELECT v FROM meta WHERE k = 'v'").toArray()[0]?.v ?? 0;
  }
  items() {
    const out = {};
    for (const r of this.sql.exec("SELECT k, v FROM items")) out[r.k] = JSON.parse(r.v);
    return out;
  }
  state() {
    return { v: this.version(), items: this.items() };
  }
  // Synchronous from check to write, so no other request can slip in between.
  put(base, items) {
    const cur = this.state();
    if (base !== cur.v) return { conflict: cur };
    this.ctx.storage.transactionSync(() => this.save(cur.v + 1, cur.items, items));
    return { v: cur.v + 1, prev: cur };
  }
  // Writes only changed rows; the free plan counts rows written.
  save(v, old, items) {
    for (const k of Object.keys(old)) if (!(k in items)) this.sql.exec("DELETE FROM items WHERE k = ?", k);
    for (const [k, x] of Object.entries(items)) {
      const s = JSON.stringify(x);
      if (JSON.stringify(old[k]) !== s) this.sql.exec("INSERT OR REPLACE INTO items VALUES (?, ?)", k, s);
    }
    this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('v', ?)", v);
  }
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const send = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!env.TOKEN || req.headers.get("Authorization") !== `Bearer ${env.TOKEN}`) return send({ error: "unauthorized" }, 401);

    const url = new URL(req.url);
    if (url.pathname === "/state") {
      const st = env.STATE.get(env.STATE.idFromName("state"));
      if (req.method === "GET") return send(await st.state());
      if (req.method === "PUT") {
        const r = await st.put(Number(url.searchParams.get("base")), (await req.json()).items || {});
        if (r.conflict) return send(r.conflict, 409);
        // The previous state stays one step back, so a bad sync can be undone by hand.
        ctx.waitUntil(env.KV.put("state:prev", JSON.stringify(r.prev)));
        return send({ v: r.v });
      }
    }
    if (url.pathname === "/books" && req.method === "GET") {
      const ids = [];
      let cursor;
      do {
        const page = await env.KV.list({ prefix: "book:", cursor });
        ids.push(...page.keys.map((k) => k.name.slice(5)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return send(ids);
    }
    const m = /^\/book\/([\w-]{1,64})$/.exec(url.pathname);
    if (m && req.method === "GET") return send((await env.KV.get(`book:${m[1]}`)) || "null", 200);
    if (m && req.method === "PUT") {
      await env.KV.put(`book:${m[1]}`, await req.text());
      return send({ ok: true });
    }
    return send({ error: "not found" }, 404);
  },
};
