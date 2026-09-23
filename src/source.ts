// Where translations and dictionary data come from: Language Reactor, or ChatGPT/Claude with the user's key.
import * as ai from "./aitr";
import { cacheSet, hdKey, hdLemmaKey, trKey as lrTrKey } from "./db";
import * as lr from "./lr";

export type Source = { id: string; ai?: ai.AiCfg; batchChars: number };

export const LR: Source = { id: "lr", batchChars: 500 };
export const aiSource = (cfg: ai.AiCfg): Source => ({ id: `${cfg.provider}:${cfg.model}`, ai: cfg, batchChars: 1500 });

// AI results are cached apart from Language Reactor's: switching the source re-translates on demand.
export const trKey = (src: Source, text: string, lang: lr.Lang) => (src.ai ? `trx|${src.id}|${lang.sl}|${lang.tl}|${text}` : lrTrKey(text, lang));

export async function translate(src: Source, texts: string[], lang: lr.Lang, pace?: lr.Pace): Promise<lr.Translated[]> {
  if (!src.ai) return lr.translate(texts, lang, pace);
  const res = await ai.translate(texts, lang, src.ai, pace);
  // Word glosses come with the sentence, stored as dictionary entries so a tap needs no request.
  await Promise.all(
    res.flatMap((r) =>
      r.nlp.flatMap((t) => {
        const g = t.pos !== "WS" && t.pos !== "PUNCT" && r.glosses[t.form.text.toLowerCase()];
        return g && g.length ? [cacheSet(hdKey(t.form.text, t, lang), g), cacheSet(hdLemmaKey(t, lang), g)] : [];
      }),
    ),
  );
  return res.map(({ tr, nlp }) => ({ tr, nlp }));
}

export async function gloss(src: Source, form: string, t: lr.Token | undefined, sentence: string, lang: lr.Lang): Promise<string[]> {
  if (!src.ai) return lr.hoverDict(form, t, lang);
  const entries = await ai.dictionary(form, t?.lemma?.text || form, t?.pos || "", sentence, lang, src.ai);
  return entries.flatMap((e) => e.posGroups.flatMap((g) => g.translations)).slice(0, 3);
}

export async function dictionary(src: Source, form: string, t: lr.Token | undefined, sentence: string, lang: lr.Lang): Promise<lr.DictEntry[]> {
  if (!src.ai) return lr.fullDict(form, t, lang);
  return ai.dictionary(form, t?.lemma?.text || form, t?.pos || "", sentence, lang, src.ai);
}
