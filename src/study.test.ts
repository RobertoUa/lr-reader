import { expect, test } from "vitest";
import { dayKey, density, due, grade, INTERVALS, lastDays, type WordEntry } from "./study";

const entry = (over: Partial<WordEntry> = {}): WordEntry => ({
  lemma: "casa", form: "casas", stage: "LEARNING", bookId: "b", bookTitle: "B", ch: 0, si: 0, offset: 0, text: "", tr: "",
  glosses: [], prev: null, next: null, ref: {}, at: 0, box: 0, due: 0, ...over,
});

test("grade moves up a box on good, back to the start on again", () => {
  const now = 1_000_000;
  const g = grade(entry({ box: 1 }), true, now);
  expect(g.box).toBe(2);
  expect(g.due).toBe(now + INTERVALS[2]);
  const a = grade(entry({ box: 3 }), false, now);
  expect(a.box).toBe(0);
  expect(a.due).toBe(now + 10 * 60000);
  expect(grade(entry({ box: INTERVALS.length - 1 }), true, now).box).toBe(INTERVALS.length - 1);
});

test("due lists only LEARNING words whose time has come, oldest first", () => {
  const list = [entry({ lemma: "a", due: 5 }), entry({ lemma: "b", due: 1 }), entry({ lemma: "c", due: 50 }), entry({ lemma: "d", due: 1, stage: "KNOWN" })];
  expect(due(list, 10).map((e) => e.lemma)).toEqual(["b", "a"]);
});

test("density counts distinct words missing from both lists", () => {
  const stages: Record<string, string> = { el: "KNOWN", gato: "LEARNING" };
  expect(density(["el", "gato", "come", "el", "pescado", "."], (l) => stages[l])).toEqual({ distinct: 4, unknown: 2, pct: 50 });
  expect(density([], () => undefined)).toEqual({ distinct: 0, unknown: 0, pct: 0 });
});

test("day keys", () => {
  expect(dayKey(Date.UTC(2026, 8, 23, 12))).toMatch(/^2026-09-2\d$/);
  expect(lastDays(3, Date.UTC(2026, 8, 23, 12))).toHaveLength(3);
});
