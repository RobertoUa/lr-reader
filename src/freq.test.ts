import { expect, test } from "vitest";
import { isEnglish } from "./freq";

test("isEnglish skips English glossary lines but not Spanish", () => {
  expect(isEnglish("The dog was in the house and he was happy.")).toBe(true);
  expect(isEnglish("El perro estaba en la casa y era feliz.")).toBe(false);
  expect(isEnglish("")).toBe(false);
});
