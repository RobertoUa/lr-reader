import { expect, test } from "vitest";
import { drop, enqueue, flush } from "./outbox";

test("latest mark per key wins", () => {
  let q = enqueue([], "save", "WORD|a|es", { v: 1 });
  q = enqueue(q, "save", "WORD|b|es", { v: 2 });
  q = enqueue(q, "remove", "WORD|a|es");
  expect(q.map((e) => [e.op, e.key])).toEqual([["save", "WORD|b|es"], ["remove", "WORD|a|es"]]);
  expect(drop(q, "WORD|b|es").map((e) => e.key)).toEqual(["WORD|a|es"]);
});

test("flush removes sent entries and keeps failures with their error", async () => {
  const q = enqueue(enqueue([], "save", "ok"), "save", "bad");
  const sent: string[] = [];
  const left = await flush(q, async (e) => {
    if (e.key === "bad") throw new Error("Language Reactor: BAD_REQUEST");
    sent.push(e.key);
  });
  expect(sent).toEqual(["ok"]);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ key: "bad", attempts: 1, error: "Language Reactor: BAD_REQUEST" });
  expect((await flush(left, async () => {}))).toEqual([]);
});
