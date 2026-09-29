import { expect, test } from "vitest";
import { isEnglish } from "./freq";

test("isEnglish skips English glossary lines but not Spanish", () => {
  expect(isEnglish("The dog was in the house and he was happy.")).toBe(true);
  expect(isEnglish("El perro estaba en la casa y era feliz.")).toBe(false);
  expect(isEnglish("")).toBe(false);
});

test("Spanish number words", async () => {
  const { numberWord } = await import("./freq");
  for (const w of ["setenta", "setecientos", "quinientas", "veintitr\u00e9s", "dieciocho", "mil", "mill\u00f3n", "cien"]) expect(numberWord(w)).toBe(true);
  for (const w of ["ventana", "setentero", "cientos de"]) expect(numberWord(w)).toBe(false);
});
