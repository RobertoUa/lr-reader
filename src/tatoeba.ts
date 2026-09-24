// Example sentences from Tatoeba (CC BY 2.0 FR), with human translations into the reader's language
// or English. The API answers any origin, so the browser calls it directly.
const ISO3: Record<string, string> = {
  es: "spa", en: "eng", uk: "ukr", ru: "rus", de: "deu", fr: "fra", it: "ita", pt: "por", pl: "pol",
  nl: "nld", tr: "tur", ja: "jpn", zh: "cmn", ko: "kor", sv: "swe", cs: "ces", ca: "cat",
};
export type Example = { text: string; tr: string };
type Sentence = { id: number; text: string; translations: { lang: string; text: string }[] };

export const supported = (sl: string) => sl in ISO3;

export async function examples(form: string, lemma: string, sl: string, tl: string): Promise<Example[]> {
  const to = [...new Set([ISO3[tl], "eng"].filter(Boolean))].join(",");
  const get = async (word: string): Promise<Sentence[]> => {
    const q = new URLSearchParams({ lang: ISO3[sl], q: `=${word}`, "trans:lang": to, "showtrans:lang": to, sort: "random", limit: "5", word_count: "4-16" });
    const r = await fetch(`https://api.tatoeba.org/unstable/sentences?${q}`);
    if (!r.ok) throw new Error(`Tatoeba: ${r.status} ${r.statusText}`);
    return (await r.json()).data;
  };
  let found = await get(form);
  // Too few with the written form: fill up with the dictionary form.
  if (found.length < 5 && lemma !== form) {
    const ids = new Set(found.map((s) => s.id));
    found = [...found, ...(await get(lemma)).filter((s) => !ids.has(s.id))].slice(0, 5);
  }
  return found.map((s) => ({ text: s.text, tr: (s.translations.find((t) => t.lang === ISO3[tl]) || s.translations[0])?.text || "" }));
}
