import { expect, test } from "vitest";
import { afterFlush, drop, enqueue, flush } from "./outbox";

test("latest mark per key wins", () => {
  let q = enqueue([], "save", "WORD|a|es", "me", { v: 1 });
  q = enqueue(q, "save", "WORD|b|es", "me", { v: 2 });
  q = enqueue(q, "remove", "WORD|a|es", "me");
  expect(q.map((e) => [e.op, e.key])).toEqual([["save", "WORD|b|es"], ["remove", "WORD|a|es"]]);
  expect(drop(q, "WORD|b|es").map((e) => e.key)).toEqual(["WORD|a|es"]);
});

test("flush removes sent entries and keeps failures with their error", async () => {
  const q = enqueue(enqueue([], "save", "ok", "me"), "save", "bad", "me");
  const sent: string[] = [];
  const left = await flush(q, async (e) => {
    if (e.key === "bad") throw new Error("Language Reactor: BAD_REQUEST");
    sent.push(e.key);
  });
  expect(sent).toEqual(["ok"]);
  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ key: "bad", attempts: 1, error: "Language Reactor: BAD_REQUEST" });
  expect(await flush(left, async () => {})).toEqual([]);
});

test("afterFlush drops sent entries, keeps failures, keeps marks made during the flush", () => {
  const sent = enqueue(enqueue([], "save", "a", "me"), "save", "b", "me");
  const failed = [{ ...sent[1], attempts: 1, error: "x" }];
  const now = enqueue(sent, "save", "c", "me");
  expect(afterFlush(now, sent, failed).map((e) => [e.key, e.error])).toEqual([["b", "x"], ["c", undefined]]);
});

test("afterFlush does not bring back a failed entry the user undid during the flush", () => {
  const sent = enqueue([], "save", "a", "me");
  const now = drop(sent, "a");
  expect(afterFlush(now, sent, [{ ...sent[0], attempts: 1, error: "x" }])).toEqual([]);
});

test("afterFlush keeps a newer mark for a key that was sent meanwhile", () => {
  const sent = enqueue([], "save", "a", "me");
  const now = enqueue(sent, "remove", "a", "me");
  expect(afterFlush(now, sent, []).map((e) => e.op)).toEqual(["remove"]);
});
