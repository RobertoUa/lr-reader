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
