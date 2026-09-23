import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Book, Chapter } from "./epub";
import { sentences } from "./split";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// head: this line starts a chapter with that title; cont: it continues the heading above it.
type Line = { text: string; x: number; y: number; w: number; h: number; head?: string; cont?: boolean };
type Page = Line[];
type Para = { text: string; page: number; head?: string };

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);
const ENDS = /[.!?:;\u2026\u00bb"\u201d')\]]$/;
const NUM = /^\d{1,3}$/;
const HEADING = /^(Cap[i\u00ed]tulo|CAP[I\u00cd]TULO|Chapter|CHAPTER|Parte|PARTE|Part|PART)\s+(\d+|[IVXLC]+\b|\p{Lu})/u;
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function readLines(page: pdfjs.PDFPageProxy): Promise<Page> {
  const tc = await page.getTextContent();
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const it of tc.items) {
    if (!("str" in it)) continue;
    const [, , , , x, y] = it.transform;
    // A new line starts when the baseline moves by more than half the glyph height.
    if (!cur || Math.abs(y - cur.y) > Math.max(2, it.height / 2)) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { text: "", x, y, w: 0, h: it.height };
    }
    cur.text += it.str;
    cur.w = Math.max(cur.w, x + it.width - cur.x);
    if (it.hasEOL) cur.text += " ";
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }));
}

// Running headers and footers: short lines at the top or bottom that repeat across pages once digits
// are ignored. Lone numbers at the edges of most pages are page numbers.
function dropFurniture(pages: Page[]): Page[] {
  const edge = (p: Page, i: number) => i < 2 || i >= p.length - 2;
  const count = new Map<string, number>();
  for (const p of pages) for (const [i, l] of p.entries()) if (edge(p, i)) count.set(l.text.replace(/\d+/g, "#"), (count.get(l.text.replace(/\d+/g, "#")) || 0) + 1);
  const min = Math.max(3, pages.length * 0.2);
  const numbered = pages.filter((p) => p.some((l, i) => edge(p, i) && NUM.test(l.text))).length > pages.length / 2;
  return pages.map((p) =>
    p.filter((l, i) => !edge(p, i) || !((numbered && NUM.test(l.text)) || ((count.get(l.text.replace(/\d+/g, "#")) || 0) >= min && l.text.length < 80))),
  );
}

type Hit = { title: string; cont?: boolean };

// Pages listing three or more chapter titles are a table of contents, not chapter starts.
function markLines(pages: Page[], hit: (p: Page, i: number) => Hit | null): number {
  const found: [Page, number, Hit][] = [];
  for (const p of pages) {
    const here = p.map((_, i) => [p, i, hit(p, i)] as [Page, number, Hit | null]).filter((x): x is [Page, number, Hit] => !!x[2]);
    if (here.length < 3) found.push(...here);
  }
  if (found.length < 2) return 0;
  for (const [p, i, h] of found) {
    p[i].head = h.title;
    if (h.cont) p[i + 1].cont = true;
  }
  return found.length;
}

function markChapters(pages: Page[], outline: { page: number; title: string }[]): boolean {
  // Bookmarks that point at distinct pages: the chapter starts at the top of that page.
  const distinct = new Set(outline.map((o) => o.page)).size;
  if (distinct >= 2 && distinct >= outline.length * 0.6) {
    for (const o of outline) {
      const l = pages[o.page]?.[0];
      if (l && !l.head) l.head = o.title;
    }
    return true;
  }
  // Bookmarks whose targets are broken: find their titles in the text instead.
  const titles = new Map(outline.map((o) => [norm(o.title), o.title]));
  const byTitle = (p: Page, i: number): Hit | null => {
    const one = titles.get(norm(p[i].text));
    if (one) return { title: one };
    const two = p[i + 1] && titles.get(norm(`${p[i].text} ${p[i + 1].text}`));
    return two ? { title: two, cont: true } : null;
  };
  if (titles.size >= 2 && markLines(pages, byTitle)) return true;
  // "Capitulo 1" style lines; a short line right after a bare "Capitulo 1:" is its title.
  const byPattern = (p: Page, i: number): Hit | null => {
    const l = p[i], next = p[i + 1];
    if (l.text.length >= 80 || !HEADING.test(l.text)) return null;
    const titled = /^\S+\s+\S+[:.]?$/.test(l.text) && next && next.text.length < 70 && !ENDS.test(next.text);
    return titled ? { title: `${l.text} ${next.text}`, cont: true } : { title: l.text };
  };
  if (markLines(pages, byPattern)) return true;
  // Chapter numbers on a line of their own, 1, 2, 3..., with a short title line after them.
  let want = 1;
  const seq: [Page, number][] = [];
  for (const p of pages) for (const [i, l] of p.entries()) if (NUM.test(l.text) && Number(l.text) === want) seq.push([p, i]), want++;
  if (seq.length < 3) return false;
  for (const [p, i] of seq) {
    const next = p[i + 1];
    const titled = next && next.text.length < 70 && !ENDS.test(next.text);
    p[i].head = titled ? `${p[i].text}. ${next.text}` : `Chapter ${p[i].text}`;
    if (titled) next.cont = true;
  }
  return true;
}

// Joins lines into paragraphs: a break is a larger vertical gap, a short line that ends a sentence,
// or a chapter heading. A paragraph that does not end a sentence continues on the next page.
function paragraphs(pages: Page[]): Para[] {
  const out: Para[] = [];
  let para: Para | null = null;
  const flush = () => {
    if (para?.text) out.push(para);
    para = null;
  };
  for (const [pi, p] of pages.entries()) {
    const gaps = p.slice(1).map((l, i) => Math.abs(p[i].y - l.y)).filter((g) => g > 0);
    const gap = median(gaps) || 14;
    const width = Math.max(0, ...p.map((l) => l.w));
    const left = median(p.map((l) => l.x));
    p.forEach((l, i) => {
      const prev = p[i - 1];
      const inHeading = !!para?.head && !l.head;
      const brk =
        !!l.head ||
        (inHeading && !l.cont) ||
        (!!prev && !inHeading && (Math.abs(prev.y - l.y) > gap * 1.4 || (ENDS.test(prev.text) && (prev.w < width * 0.85 || l.x > left + 8))));
      if (brk || !para) {
        flush();
        para = { text: "", page: pi, head: l.head };
      }
      const t = para!.text;
      // Rejoin words hyphenated across lines.
      para!.text = /\p{L}-$/u.test(t) && /^\p{Ll}/u.test(l.text) ? t.slice(0, -1) + l.text : t ? `${t} ${l.text}` : l.text;
    });
    if (para && (ENDS.test((para as Para).text) || (para as Para).head)) flush();
  }
  flush();
  return out;
}

async function outlineEntries(doc: pdfjs.PDFDocumentProxy): Promise<{ page: number; title: string }[]> {
  const out: { page: number; title: string }[] = [];
  for (const o of (await doc.getOutline()) || []) {
    try {
      const dest = typeof o.dest === "string" ? await doc.getDestination(o.dest) : o.dest;
      if (dest) out.push({ page: await doc.getPageIndex(dest[0]), title: o.title.trim() });
    } catch {}
  }
  return out.sort((a, b) => a.page - b.page);
}

export async function parsePdf(data: Uint8Array, name: string, lang = "es", onPage?: (n: number, total: number) => void): Promise<Book> {
  const doc = await pdfjs.getDocument({ data }).promise;
  let pages: Page[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    pages.push(await readLines(await doc.getPage(i)));
    onPage?.(i, doc.numPages);
  }
  if (!pages.some((p) => p.length)) throw new Error("This PDF has no text layer (scanned pages?), so there is nothing to read");
  pages = dropFurniture(pages);
  const marked = markChapters(pages, await outlineEntries(doc));
  const paras = paragraphs(pages);

  const block = (t: string, tag: "p" | "h") => ({ tag, sentences: sentences(t, lang) });
  const chapters: Chapter[] = [];
  for (const p of paras) {
    // Without any chapter marks, every 10 pages.
    const start = marked ? p.head : !chapters.length || p.page >= (chapters.length) * 10 ? `Pages ${p.page + 1}-${Math.min(p.page + 10, pages.length)}` : undefined;
    if (start) chapters.push({ title: start, blocks: [] });
    else if (!chapters.length) chapters.push({ title: "Start", blocks: [] });
    chapters[chapters.length - 1].blocks.push(block(p.text, p.head ? "h" : "p"));
  }
  const kept = chapters.map((c) => ({ ...c, blocks: c.blocks.filter((b) => b.sentences.length) })).filter((c) => c.blocks.length);

  const info = ((await doc.getMetadata()).info || {}) as { Title?: string; Author?: string };
  await doc.cleanup();
  // Some PDFs carry a file name as their title; the imported file's name reads better then.
  const title = info.Title?.trim() && !/\.(pdf|docx?)$/i.test(info.Title.trim()) ? info.Title.trim() : name.replace(/\.pdf$/i, "");
  return { title, author: info.Author?.trim() || "", chapters: kept };
}
