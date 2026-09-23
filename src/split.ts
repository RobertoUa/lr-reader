const segmenters = new Map<string, Intl.Segmenter>();

export function sentences(text: string, lang = "es"): string[] {
  let seg = segmenters.get(lang);
  if (!seg) segmenters.set(lang, (seg = new Intl.Segmenter(lang, { granularity: "sentence" })));
  return [...seg.segment(text.replace(/\s+/g, " ").trim())].map((s) => s.segment.trim()).filter(Boolean);
}
