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
