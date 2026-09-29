// Word popularity: the 50,000 most frequent Spanish words from wordfreq (Robyn Speer; Wikipedia, subtitles,
// news, books, web; CC BY-SA 4.0), letters-only, one word per line in rank order. Blended sources rank
// book vocabulary better than subtitles alone.
let ranks: Promise<Map<string, number>> | null = null;
let loadedMap: Map<string, number> | null = null;

// Synchronous rank for mark(), once the list has loaded; undefined for rare words or before loading.
export const rankNow = (w: string) => loadedMap?.get(w);
export const ready = () => loadedMap !== null;
export const preload = () => load().then((m) => void (loadedMap = m));

export const supported = (sl: string) => sl === "es";

// Spanish number words, never worth underlining (Language Reactor lists rarely hold them).
const NUMBER = /^(cero|uno?|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\p{L}+|veinte|veinti\p{L}+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\p{L}*cient[oa]s|quinient[oa]s|mil|mill[o\u00f3]n|millones)$/u;
export const numberWord = (w: string) => NUMBER.test(w);

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

export type Level = { label?: string; common?: number; cefr?: string; why?: string; tried?: number };

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
