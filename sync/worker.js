// LR Reader sync: one user's reading state and books in Workers KV, behind a bearer token (secret TOKEN).
// GET/PUT /state (PUT needs ?base=<version it merged from>, 409 with the current state if that is stale),
// GET /books (ids), GET/PUT /book/<id>.
const ORIGINS = ["https://robertoua.github.io", "capacitor://localhost", "http://localhost:5173", "http://127.0.0.1:4173"];

export default {
  async fetch(req, env) {
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
      const cur = (await env.KV.get("state")) || '{"v":0}';
      if (req.method === "GET") return send(cur);
      if (req.method === "PUT") {
        if (Number(url.searchParams.get("base")) !== JSON.parse(cur).v) return send(cur, 409);
        const next = await req.json();
        next.v = (JSON.parse(cur).v || 0) + 1;
        await env.KV.put("state", JSON.stringify(next));
        return send({ v: next.v });
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
