import { expect, test } from "vitest";
import { sentences } from "./split";

test("splits Spanish sentences, keeping inverted marks and dialogue", () => {
  expect(sentences("Hola, Juan. ¿Cómo estás? ¡Muy bien!\n  Adiós...  Nos vemos.")).toEqual([
    "Hola, Juan.",
    "¿Cómo estás?",
    "¡Muy bien!",
    "Adiós...",
    "Nos vemos.",
  ]);
});

test("collapses whitespace and drops empties", () => {
  expect(sentences("   ")).toEqual([]);
  expect(sentences("Una\nlínea   sola")).toEqual(["Una línea sola"]);
});
