import { expect, test } from "vitest";
import { sentences } from "./split";

test("splits Spanish sentences, keeping inverted marks and dialogue", () => {
  expect(sentences("Hola, Juan. \u00bfC\u00f3mo est\u00e1s? \u00a1Muy bien!\n  Adi\u00f3s...  Nos vemos.")).toEqual([
    "Hola, Juan.",
    "\u00bfC\u00f3mo est\u00e1s?",
    "\u00a1Muy bien!",
    "Adi\u00f3s...",
    "Nos vemos.",
  ]);
});

test("collapses whitespace and drops empties", () => {
  expect(sentences("   ")).toEqual([]);
  expect(sentences("Una\nl\u00ednea   sola")).toEqual(["Una l\u00ednea sola"]);
});
