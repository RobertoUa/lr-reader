// Word popularity from the 50,000 most frequent Spanish words in film subtitles (FrequencyWords by
// Hermit Dave, OpenSubtitles 2018, CC BY-SA 4.0), one word per line in rank order.
let ranks: Promise<Map<string, number>> | null = null;

export const supported = (sl: string) => sl === "es";

function load() {
  ranks ||= fetch("freq-es.txt")
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`frequency list: HTTP ${r.status}`))))
    .then((t) => new Map(t.split("\n").map((w, i) => [w.trim(), i + 1] as [string, number])));
  ranks.catch(() => (ranks = null));
  return ranks;
}

// The better of the written form and the dictionary form: "com\u00edan" is rarer than "comer".
export async function popularity(form: string, lemma: string): Promise<string> {
  const m = await load();
  const r = Math.min(m.get(form.toLowerCase()) ?? Infinity, m.get(lemma.toLowerCase()) ?? Infinity);
  if (r === Infinity) return "rare (not in the top 50,000)";
  const band = r <= 1000 ? "very common" : r <= 5000 ? "common" : r <= 20000 ? "less common" : "rare";
  return `#${r.toLocaleString("en")} \u00b7 ${band}`;
}

export type Level = { label?: string; common?: number; cefr?: string; why?: string };

// Learner editions mix in English glossaries and translations; those sentences are left out.
const EN = new Set("the and of to is you that it in for with was this are have what he she they his her be at on not but from or an which my your were had would will there their".split(" "));
export const isEnglish = (s: string) => {
  const ws = s.match(/\p{L}+/gu) || [];
  return ws.length > 0 && ws.filter((w) => EN.has(w.toLowerCase())).length * 5 >= ws.length;
};

// Share of running words among the 3,000 most frequent forms (names skipped). It separates books only
// roughly, so an AI rating replaces it when a key is set.
export async function difficulty(sentences: string[]): Promise<Level> {
  const m = await load();
  let words = 0, common = 0;
  for (const s of sentences) {
    if (isEnglish(s)) continue;
    for (const w of s.match(/\p{L}+/gu) || []) {
      const lw = w.toLowerCase(), r = m.get(lw);
      if (r === undefined && w[0] !== lw[0]) continue;
      words++;
      if (r !== undefined && r <= 3000) common++;
    }
  }
  const pct = words ? Math.round((common / words) * 100) : 0;
  return { label: pct >= 84 ? "Easy" : pct >= 78 ? "Medium" : pct >= 72 ? "Hard" : "Very hard", common: pct };
}
