// Every Language Reactor call lives here: the API is unofficial and may change.
export const DICT = "https://api-cdn-plus.dioco.io/";
export const ITEMS = "https://api-cdn.dioco.io/";

export type Token = {
  form: { text: string };
  form_norm: { text: string };
  lemma?: { text: string };
  pos: string;
  diocoFreq?: number | string;
  [k: string]: unknown;
};
export type Lang = { sl: string; tl: string };
export type Auth = { email: string; token: string };
export type Translated = { tr: string; nlp: Token[] };
export type Stage = "LEARNING" | "KNOWN";

async function call(url: string, body?: unknown): Promise<any> {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    throw new Error(`Language Reactor unreachable: ${(e as Error).message}`);
  }
  const j = await r.json().catch(() => null);
  if (j?.error === "TOKEN_ERROR") throw new Error("Language Reactor rejected the token (TOKEN_ERROR); update it in Settings");
  if (!j || j.status !== "success") throw new Error(`Language Reactor: ${j?.error || j?.status || `HTTP ${r.status}`}`);
  return j.data;
}

const joined = (nlp: Token[]) => nlp.map((t) => t.form.text).join("").replace(/\s+/g, " ").trim();

async function translateOne(text: string, lang: Lang): Promise<Translated> {
  const d = await call(`${DICT}base_dict_fullDictTranslate_2`, { input: { type: "TEXT", text: text.slice(0, 500) }, ...lang, mode: "NORMAL" });
  // The server does its own sentence split, so one of our sentences can come back as several.
  return { tr: (d.mTranslations as string[]).join("").trim(), nlp: (d.nlp as Token[][]).flat() };
}

// Several sentences per request, joined with a blank line, which the server keeps as a boundary more
// reliably than "\n". It still re-splits text itself, so the batch is used only when its pieces line up
// with ours one to one; otherwise each sentence goes alone.
export async function translate(texts: string[], lang: Lang): Promise<Translated[]> {
  if (texts.length > 1 && texts.join("\n\n").length <= 500) {
    const d = await call(`${DICT}base_dict_fullDictTranslate_2`, { input: { type: "TEXT", text: texts.join("\n\n") }, ...lang, mode: "NORMAL" });
    const nlp = d.nlp as Token[][];
    if (nlp.length === texts.length && d.mTranslations.length === texts.length && nlp.every((n, i) => joined(n) === texts[i].replace(/\s+/g, " ").trim())) {
      return nlp.map((n, i) => ({ tr: String(d.mTranslations[i]).trim(), nlp: n }));
    }
  }
  const out: Translated[] = [];
  for (const t of texts) out.push(await translateOne(t, lang));
  return out;
}

const dictQuery = (form: string, t: Token | undefined, lang: Lang) => {
  const lemma = t?.lemma && t.lemma.text.toLowerCase() !== form.toLowerCase() ? t.lemma.text : "";
  return new URLSearchParams({ form: form.toLowerCase(), lemma, ...lang, pos: t?.pos || "", pow: "n" });
};

export const hoverDict = async (form: string, t: Token | undefined, lang: Lang): Promise<string[]> =>
  (await call(`${DICT}base_dict_getHoverDict_8?${dictQuery(form, t, lang)}`)).hoverDictEntries || [];

export type DictEntry = { word: string; posGroups: { pos: string; translations: string[] }[] };
export const fullDict = async (form: string, t: Token | undefined, lang: Lang): Promise<DictEntry[]> =>
  (await call(`${DICT}base_dict_getFullDict_8?${dictQuery(form, t, lang)}`)).renderData?.fullDictRenderData?.entries || [];

export const tts = async (text: string, sl: string): Promise<string> =>
  call(`${DICT}base_dict_getDictTTS_3?${new URLSearchParams({ lang: sl, text: text.toLowerCase() })}`);

const items = (path: string, auth: Auth, body: object) => call(`${ITEMS}${path}`, { ...body, userEmail: auth.email, diocoToken: auth.token });

// Saved words, lemma (lowercase) -> stage.
export async function itemKeys(auth: Auth, sl: string): Promise<Record<string, Stage>> {
  const d = await items("base_items_getItemKeys_3", auth, {});
  const word = d.itemKeys?.itemKeys?.[sl]?.WORD || {};
  const out: Record<string, Stage> = {};
  for (const stage of ["KNOWN", "LEARNING"] as const) for (const w of Object.keys(word[stage] || {})) out[w.toLowerCase()] = stage;
  return out;
}

export const saveItem = (auth: Auth, item: object) => items("base_items_saveItem_5", auth, { item, initProposalReviewData: false });
export const removeItem = (auth: Auth, itemKey: string) => items("base_items_removeItem", auth, { itemKey });
export const getItems = (auth: Auth, body: object) => items("base_items_getItems_5", auth, body);

// MD5 of the UTF-8 bytes, for phrase keys; WebCrypto has no MD5.
export function md5(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = ((bytes.length + 8) >> 6) + 1;
  const x = new Array<number>(blocks * 16).fill(0);
  for (let i = 0; i < bytes.length; i++) x[i >> 2] |= bytes[i] << ((i % 4) * 8);
  x[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  x[blocks * 16 - 2] = bytes.length * 8;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
  let h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
  for (let o = 0; o < x.length; o += 16) {
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const f = r === 0 ? (b & c) | (~b & d) : r === 1 ? (d & b) | (~d & c) : r === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = r === 0 ? i : r === 1 ? (5 * i + 1) % 16 : r === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
      const t = (a + f + K[i] + x[o + g]) | 0;
      const sh = S[r * 4 + (i % 4)];
      [a, b, c, d] = [d, (b + ((t << sh) | (t >>> (32 - sh)))) | 0, b, c];
    }
    h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0];
  }
  return h.map((v) => [0, 8, 16, 24].map((k) => ((v >>> k) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

export type Ref = Record<string, unknown>;
export const bookRef = (bookId: string, title: string, sl: string, index: number): Ref => ({
  refVersion: 2,
  source: "USER_TEXT",
  url: null,
  diocoDocId: "ud_" + md5(bookId).slice(0, 12),
  diocoDocName: title,
  diocoPlaylistId: `uu_all_${sl}`,
  diocoPlaylistName: "User Media",
  subtitleIndex: index,
});

export type Context = { text: string; tr: string; nlp: Token[]; prev: string | null; next: string | null; ref: Ref };

function phrase(c: Context, text = c.text, tr = c.tr) {
  return {
    subtitleTokens: { 0: null, 1: c.nlp, 2: null },
    subtitles: { 0: c.prev, 1: text, 2: c.next },
    mTranslations: tr ? { 0: null, 1: tr, 2: null } : null,
    hTranslations: null,
    reference: c.ref,
    thumb_prev: null,
    thumb_next: null,
  };
}

// wordIndex counts over the full token list, whitespace tokens included; the server rejects anything else.
export function wordItem(lemma: string, stage: Stage, wordIndex: number, c: Context, lang: Lang) {
  const t = c.nlp[wordIndex];
  const freq = t?.diocoFreq ?? "NO_FREQ_DATA";
  return {
    itemType: "WORD",
    key: `WORD|${lemma.toLowerCase()}|${lang.sl}`,
    langCode_G: lang.sl,
    translationLangCode_G: lang.tl,
    tags: [],
    wordTranslationsArr: null,
    wordType: t?.lemma ? "lemma" : "form",
    // The server checks this against the token's lemma exactly as it spells it ("Espa\u00f1ol").
    word: { text: t?.lemma?.text || lemma },
    freqRank: typeof freq === "number" ? freq : null,
    context: { phrase: phrase(c), wordIndex },
    audio: null,
    learningStage: stage,
    reviewData: null,
    reviewHistory: null,
    timeModified_ms: 0,
    timeCreated_ms: 0,
    diocoFreq: freq,
    source: c.ref.source,
  };
}

export const wordKey = (lemma: string, sl: string) => `WORD|${lemma.toLowerCase()}|${sl}`;

export function phraseItem(text: string, tr: string, nlp: Token[], c: Context, lang: Lang) {
  const freqs = nlp.map((t) => t.diocoFreq).filter((f): f is number => typeof f === "number");
  return {
    itemType: "PHRASE",
    key: `PHRASE-YT|${lang.sl}|${md5(text).slice(0, 16)}`,
    langCode_G: lang.sl,
    translationLangCode_G: lang.tl,
    context: { phrase: { ...phrase(c, text, tr), subtitleTokens: { 0: null, 1: nlp, 2: null } } },
    audio: null,
    learningStage: "LEARNING",
    tags: [],
    timeModified_ms: 0,
    timeCreated_ms: 0,
    reviewData: null,
    reviewHistory: null,
    freqRank: freqs.length ? Math.round(freqs.reduce((a, b) => a + b) / freqs.length) : 20000,
    source: c.ref.source,
  };
}
