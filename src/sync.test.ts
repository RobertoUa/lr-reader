import { expect, test } from "vitest";
import { merge3 } from "./sync";

test("three-way merge: one-sided edits and deletions win, both-sided keeps local, edit beats delete", () => {
  const base = { a: 1, b: 1, c: 1, d: 1, e: 1 };
  const local = { a: 2, b: 1, d: 5, e: 7, n: 1 };
  const remote = { a: 1, b: 3, c: 1, d: 6, r: 1 };
  expect(merge3(base, local, remote)).toEqual({ a: 2, b: 3, d: 5, e: 7, n: 1, r: 1 });
  // First sync of a new device: nothing in common yet, the server's values win, both sides' items are kept.
  expect(merge3({}, { prefs: "defaults", mine: 1 }, { prefs: "real", theirs: 2 }, true)).toEqual({ prefs: "real", mine: 1, theirs: 2 });
});
