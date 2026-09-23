// Sentence translation, word analysis and dictionary entries from ChatGPT or Claude with the user's key,
// in the same shape as Language Reactor's, so the reader, highlighting and saving work unchanged.
import type { DictEntry, Lang, Pace, Token, Translated } from "./lr";

export type AiCfg = { provider: "openai" | "claude"; key: string; model: string };
export type AiTranslated = Translated & { glosses: Record<string, string[]> };

const UPOS = ["ADJ", "ADP", "ADV", "AUX", "CCONJ", "DET", "INTJ", "NOUN", "NUM", "PART", "PRON", "PROPN", "PUNCT", "SCONJ", "SYM", "VERB", "X"];
const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const TRANSLATION_SCHEMA = obj({
  sentences: {
    type: "array",
    items: obj({
      translation: { type: "string" },
      words: { type: "array", items: obj({ word: { type: "string" }, lemma: { type: "string" }, pos: { type: "string", enum: UPOS }, glosses: { type: "array", items: { type: "string" } } }) },
    }),
  },
});
const DICT_SCHEMA = obj({ entries: { type: "array", items: obj({ word: { type: "string" }, posGroups: { type: "array", items: obj({ pos: { type: "string" }, translations: { type: "array", items: { type: "string" } } }) } }) } });

const langName = (code: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;

async function ask<T>(cfg: AiCfg, system: string, user: string, schema: object): Promise<T> {
  if (!cfg.key) throw new Error(`Translations are set to ${cfg.provider === "openai" ? "ChatGPT" : "Claude"}: add its API key in Settings`);
  if (cfg.provider === "openai") {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        reasoning_effort: "low",
        response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`ChatGPT: ${r.status} ${j?.error?.message || r.statusText}`);
    return JSON.parse(j.choices[0].message.content);
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // The key stays on this device; the browser calls the API directly because the app has no server.
  const client = new Anthropic({ apiKey: cfg.key, dangerouslyAllowBrowser: true });
  const current = cfg.model === "claude-opus-5" || cfg.model === "claude-sonnet-5";
  const msg = await client.beta.messages.create({
    model: cfg.model,
    max_tokens: 16000,
    system,
    messages: [{ role: "user", content: user }],
    // Routine work: low effort keeps it fast. Haiku 4.5 takes no effort setting.
    output_config: { format: { type: "json_schema", schema: schema as Record<string, unknown> }, ...(current ? { effort: "low" as const } : {}) },
    ...(cfg.model === "claude-opus-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined this text");
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return JSON.parse(text);
}

// Tokens in Language Reactor's shape, cut from the sentence itself so offsets line up; the model only
// supplies dictionary form and part of speech, matched to the words in order.
const PIECES = /[\p{L}\p{M}\p{N}]+(?:['\u2019-][\p{L}\p{M}\p{N}]+)*|\s+|[^\s\p{L}\p{M}\p{N}]/gu;
function tokens(text: string, words: { word: string; lemma: string; pos: string }[]): Token[] {
  let j = 0;
  return [...text.matchAll(PIECES)].map(([t]) => {
    if (/^\s+$/.test(t)) return { form: { text: t }, form_norm: { text: t }, pos: "WS" };
    if (!/[\p{L}\p{N}]/u.test(t)) return { form: { text: t }, form_norm: { text: t }, lemma: { text: t }, pos: "PUNCT" };
    const k = words.slice(j, j + 4).findIndex((w) => w.word.toLowerCase() === t.toLowerCase());
    const w = k >= 0 ? words[(j += k + 1) - 1] : undefined;
    return { form: { text: t }, form_norm: { text: t.toLowerCase() }, lemma: { text: w?.lemma || t.toLowerCase() }, pos: w?.pos || "X" };
  });
}

export async function translate(texts: string[], lang: Lang, cfg: AiCfg, pace: Pace = (fn) => fn()): Promise<AiTranslated[]> {
  const system =
    `You analyze ${langName(lang.sl)} sentences for a learner whose language is ${langName(lang.tl)}. For each numbered sentence give ` +
    `a natural ${langName(lang.tl)} translation, and every word in order as written (repeats included, no punctuation) with its ` +
    `dictionary form (lowercase unless a proper noun), its Universal POS tag, and 1 to 3 short ${langName(lang.tl)} translations of the word as used there. ` +
    `Return exactly one entry per sentence, in the same order.`;
  const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const out = await pace(() => ask<{ sentences: { translation: string; words: { word: string; lemma: string; pos: string; glosses: string[] }[] }[] }>(cfg, system, user, TRANSLATION_SCHEMA));
  if (out.sentences.length !== texts.length) throw new Error(`${cfg.provider === "openai" ? "ChatGPT" : "Claude"} returned ${out.sentences.length} translations for ${texts.length} sentences`);
  return out.sentences.map((s, i) => {
    const glosses: Record<string, string[]> = {};
    for (const w of s.words) glosses[w.word.toLowerCase()] ||= w.glosses;
    return { tr: s.translation, nlp: tokens(texts[i], s.words), glosses };
  });
}

export async function dictionary(word: string, lemma: string, pos: string, sentence: string, lang: Lang, cfg: AiCfg): Promise<DictEntry[]> {
  const system =
    `You are a ${langName(lang.sl)}-${langName(lang.tl)} dictionary. Give the entry for the word's dictionary form: its parts of speech ` +
    `(lowercase English names), each with the common ${langName(lang.tl)} translations, most frequent first.`;
  const user = `Word: ${word}\nDictionary form: ${lemma}\nPart of speech here: ${pos}\nSentence: ${sentence}`;
  return (await ask<{ entries: DictEntry[] }>(cfg, system, user, DICT_SCHEMA)).entries;
}
