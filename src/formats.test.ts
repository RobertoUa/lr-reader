import { expect, test } from "vitest";
import { parseTxt } from "./formats";

const txt = (s: string) => new TextEncoder().encode(s);

test("TXT chapters start at headings; a table of contents does not split chapters", () => {
  const book = parseTxt(txt("Indice\n\nCapitulo I\n\nCapitulo II\n\nCapitulo I. El comienzo\n\nEra de noche. Llovia.\n\nCapitulo II. El final\n\nTodo acabo bien."), "mi libro.txt");
  expect(book.title).toBe("mi libro");
  expect(book.chapters.map((c) => c.title)).toEqual(["Start", "Capitulo I. El comienzo", "Capitulo II. El final"]);
  expect(book.chapters[1].blocks[1].sentences).toEqual(["Era de noche.", "Llovia."]);
});

test("TXT without headings is split into parts", () => {
  const book = parseTxt(txt(Array.from({ length: 90 }, (_, i) => `Parrafo numero ${i}.`).join("\n\n")), "x.txt");
  expect(book.chapters.map((c) => c.title)).toEqual(["Part 1", "Part 2", "Part 3"]);
});

test("a sentence starting with Parte or Libro is not a chapter heading", () => {
  const book = parseTxt(txt("Capitulo 1\n\nParte de mi queria irse.\n\nLibro de cuentas.\n\nCapitulo primero. Otro\n\nTexto."), "x.txt");
  expect(book.chapters.map((c) => c.title)).toEqual(["Capitulo 1", "Capitulo primero. Otro"]);
});

test("one paragraph per line stays split even with blank lines around headings", () => {
  const long = (n: number) => `Frase ${n} ${"muy larga ".repeat(12)}fin.`;
  const book = parseTxt(txt(`Capitulo I\n\n${long(1)}\n${long(2)}\n${long(3)}\n\nCapitulo II\n\n${long(4)}\n${long(5)}`), "x.txt");
  expect(book.chapters.map((c) => c.blocks.length)).toEqual([4, 3]);
});
