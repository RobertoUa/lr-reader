// Word log, review scheduling, reading stats and unknown-word density: plain data, no DOM.

// A word marked while reading, with what review needs to show it and to mark it again later.
export type WordEntry = {
  lemma: string;
  form: string;
  stage: "LEARNING" | "KNOWN";
  sl?: string;
  bookId: string;
  bookTitle: string;
  ch: number;
  si: number;
  offset: number;
  text: string;
  tr: string;
  glosses: string[];
  prev: string | null;
  next: string | null;
  ref: Record<string, unknown>;
  at: number;
  box: number;
  due: number;
};

const DAY = 86400000;
// Leitner boxes: a correct answer moves the word up a box, "again" sends it back to the start.
export const INTERVALS = [DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

export function grade(e: WordEntry, good: boolean, now = Date.now()): WordEntry {
  const box = good ? Math.min(e.box + 1, INTERVALS.length - 1) : 0;
  return { ...e, box, due: now + (good ? INTERVALS[box] : 10 * 60000) };
}

export const due = (all: WordEntry[], now = Date.now()) => all.filter((e) => e.stage === "LEARNING" && e.due <= now).sort((a, b) => a.due - b.due);

export type Day = { ms: number; pages: number; marked: number };
export const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString("sv");
// Days in a row with the goal met, ending today, or yesterday while today's goal is still open.
export function streak(msOn: (day: string) => number, goalMs: number, now = Date.now()): number {
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  const day = (i: number) => msOn(dayKey(noon.getTime() - i * DAY));
  let i = day(0) >= goalMs ? 0 : 1, n = 0;
  while (day(i) >= goalMs) i++, n++;
  return n;
}
export const lastDays = (n: number, now = Date.now()) => Array.from({ length: n }, (_, i) => dayKey(now - i * DAY));

// Share of distinct words on a page or chapter that are in neither the Known nor the Learning list.
export function density(lemmas: string[], stageOf: (lemma: string) => string | undefined): { distinct: number; unknown: number; pct: number } {
  const set = new Set(lemmas.filter((l) => /\p{L}/u.test(l)));
  let unknown = 0;
  for (const l of set) if (!stageOf(l)) unknown++;
  return { distinct: set.size, unknown, pct: set.size ? Math.round((100 * unknown) / set.size) : 0 };
}

// Regular Spanish verb endings (present, preterite, imperfect, future, conditional, subjunctive, participles,
// gerunds). Language Reactor lists often hold a known conjugated form ("levanto") but not the infinitive.
const AR = "o|as|a|amos|ais|an|e|aste|asteis|aron|aba|abas|abamos|abais|aban|are|aras|ara|aremos|areis|aran|aria|arias|ariamos|ariais|arian|es|emos|eis|en|aramos|ase|ases|asemos|aseis|asen|ado|ada|ados|adas|ando|ar";
const ERIR = "o|es|e|emos|imos|eis|is|en|i|iste|io|isteis|ieron|ia|ias|iamos|iais|ian|ere|eras|era|eremos|ereis|eran|eria|erias|eriamos|eriais|erian|ire|iras|ira|iremos|ireis|iran|iria|irias|iriamos|iriais|irian|a|as|amos|ais|an|iera|ieras|ieramos|ierais|ieran|iese|ieses|iesemos|ieseis|iesen|ido|ida|idos|idas|iendo|er|ir";
const plain = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "");
const endings = { ar: new RegExp(`^(${AR})$`), e: new RegExp(`^(${ERIR})$`) };

// True when a word in `known` (sorted, accents removed) is a regular form of the verb `lemma`.
export function verbFamilyKnown(lemma: string, known: string[]): boolean {
  const m = /^(.{3,}?)(ar|er|ir)(se)?$/.exec(plain(lemma));
  if (!m) return false;
  const [, stem, kind] = m, re = kind === "ar" ? endings.ar : endings.e;
  let lo = 0, hi = known.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (known[mid] < stem) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < known.length && known[i].startsWith(stem); i++) if (re.test(known[i].slice(stem.length))) return true;
  return false;
}
