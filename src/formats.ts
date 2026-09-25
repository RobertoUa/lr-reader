// TXT, FB2 and MOBI into the same Book shape as EPUB.
import { unzipSync } from "fflate";
import { collect, type Block, type Book, type Chapter } from "./epub";
import { sentences } from "./split";

const baseName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ");

// UTF-8 unless the file says otherwise; bytes that are not valid UTF-8 are read as Windows-1252.
function decode(data: Uint8Array, declared?: string): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
  try {
    return new TextDecoder(declared || "utf-8", { fatal: !declared }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

const HEADING = /^(cap\u00edtulo|capitulo|chapter|parte|part|libro|book)\s+([IVXLCDM]+|\d+|primer|segund|tercer|cuart|quint|sext|s\u00e9ptim|septim|octav|noven|d\u00e9cim|decim|un|one|two|three|first|second|third)|^(pr\u00f3logo|prologo|prologue|ep\u00edlogo|epilogo|epilogue)\b|^[IVXLC]{1,7}\.?$|^\d{1,3}\.?$/i;
const textOf = (b: Block) => b.sentences.join(" ");
// A short block that starts with a capital and reads like "Capitulo II. ..." or "XII".
const isHead = (b: Block) => b.tag === "h" || (textOf(b).length <= 300 && /^\p{Lu}|^\d/u.test(textOf(b)) && HEADING.test(textOf(b)));

// Chapters start at headings when the text has at least two; otherwise fallback() decides.
// A heading right before another one (a table of contents) stays a plain paragraph.
function chapterize(blocks: Block[], fallback: () => Chapter[]): Chapter[] {
  const starts = blocks.map((b, i) => isHead(b) && !!blocks[i + 1] && !isHead(blocks[i + 1]));
  if (starts.filter(Boolean).length < 2) return fallback();
  const chapters: Chapter[] = [];
  blocks.forEach((b, i) => {
    if (starts[i] || !chapters.length) chapters.push({ title: starts[i] ? textOf(b) : "Start", blocks: [] });
    chapters.at(-1)!.blocks.push(starts[i] ? { tag: "h", sentences: [textOf(b)] } : b);
  });
  return chapters;
}
const chunks = (blocks: Block[]): Chapter[] =>
  Array.from({ length: Math.ceil(blocks.length / 40) }, (_, i) => ({ title: `Part ${i + 1}`, blocks: blocks.slice(i * 40, i * 40 + 40) }));

export function parseTxt(data: Uint8Array, name: string, lang = "es"): Book {
  const text = decode(data).replace(/\r\n?/g, "\n");
  // Paragraphs are separated by blank lines when the file has them, else one per line.
  const paras = (/\n\s*\n/.test(text) ? text.split(/\n\s*\n/) : text.split("\n")).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const blocks = paras.map((p): Block => ({ tag: "p", sentences: sentences(p, lang) })).filter((b) => b.sentences.length);
  return { title: baseName(name), author: "", chapters: chapterize(blocks, () => chunks(blocks)) };
}

export function parseFb2(data: Uint8Array, name: string, lang = "es"): Book {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const inner = Object.entries(unzipSync(data)).find(([n]) => /\.fb2$/i.test(n));
    if (!inner) throw new Error("no .fb2 file inside this zip");
    data = inner[1];
  }
  const declared = /encoding=["']([^"']+)/.exec(new TextDecoder("latin1").decode(data.subarray(0, 200)))?.[1];
  const src = decode(data, declared);
  let doc = new DOMParser().parseFromString(src, "application/xml");
  if (doc.querySelector("parsererror")) doc = new DOMParser().parseFromString(src, "text/html");
  const info = doc.querySelector("title-info");
  const a = info?.querySelector("author");
  const author = a ? ["first-name", "middle-name", "last-name"].map((t) => a.querySelector(t)?.textContent?.trim()).filter(Boolean).join(" ") : "";
  const body = [...doc.getElementsByTagName("body")].find((b) => !b.getAttribute("name")) || doc.getElementsByTagName("body")[0];
  if (!body) throw new Error("not an FB2 book (no body)");
  const blocksOf = (el: Element, out: Block[]) => {
    for (const k of el.children) {
      const n = k.localName;
      if (n === "section" || n === "image" || n === "empty-line") continue;
      const s = () => sentences(k.textContent || "", lang);
      if (n === "title" || n === "subtitle") s().length && out.push({ tag: "h", sentences: [k.textContent!.replace(/\s+/g, " ").trim()] });
      else if (n === "p" || n === "v" || n === "text-author") s().length && out.push({ tag: "p", sentences: s() });
      else blocksOf(k, out);
    }
  };
  const chapters: Chapter[] = [];
  // A section holding only a title (a part heading before its subsections) joins the next chapter.
  let carry: Block[] = [];
  for (const sec of [body, ...body.getElementsByTagName("section")]) {
    const blocks: Block[] = [...carry];
    blocksOf(sec, blocks);
    if (!blocks.some((b) => b.tag !== "h")) {
      if (sec !== body) carry = blocks;
      continue;
    }
    carry = [];
    const title = [...sec.children].find((k) => k.localName === "title")?.textContent?.replace(/\s+/g, " ").trim();
    chapters.push({ title: title || `Part ${chapters.length + 1}`, blocks });
  }
  const bookTitle = info?.querySelector("book-title")?.textContent?.trim();
  return { title: bookTitle || baseName(name), author, chapters };
}

// MOBI (PalmDOC compression, the common case); HUFF/CDIC books need converting to EPUB first.
export function parseMobi(data: Uint8Array, name: string, lang = "es"): Book {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(76);
  const start = (i: number) => v.getUint32(78 + i * 8);
  const rec = (i: number) => data.subarray(start(i), i + 1 < count ? start(i + 1) : data.length);
  const r0 = rec(0), h = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = h.getUint16(0), textRecords = h.getUint16(8);
  if (compression === 17480) throw new Error("this MOBI uses HUFF/CDIC compression, which is not supported; convert it to EPUB");
  const ascii = (b: Uint8Array) => String.fromCharCode(...b);
  const isMobi = r0.length > 20 && ascii(r0.subarray(16, 20)) === "MOBI";
  const headerLen = isMobi ? h.getUint32(20) : 0;
  const utf8 = isMobi && h.getUint32(28) === 65001;
  const extraFlags = isMobi && headerLen >= 0xe4 ? h.getUint16(0xf2) : 0;
  let title = "", author = "";
  if (isMobi) {
    const nameOff = h.getUint32(84), nameLen = h.getUint32(88);
    title = new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(r0.subarray(nameOff, nameOff + nameLen));
    if (h.getUint32(128) & 0x40) {
      const e = 16 + headerLen;
      for (let i = 0, p = e + 12; i < h.getUint32(e + 8) && p + 8 <= r0.length; i++) {
        const type = h.getUint32(p), len = h.getUint32(p + 4);
        const val = new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(r0.subarray(p + 8, p + len));
        if (type === 100 && !author) author = val;
        if (type === 503) title = val;
        p += len;
      }
    }
  }
  const parts: Uint8Array[] = [];
  for (let i = 1; i <= textRecords && i < count; i++) {
    const r = rec(i);
    const body = r.subarray(0, r.length - trailing(r, extraFlags));
    parts.push(compression === 2 ? palmdoc(body) : body);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (all.set(p, o), o + p.length), 0);
  const html = new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(all);
  const pieces = html
    .split(/<mbp:pagebreak[^>]*>/i)
    .map((piece) => {
      const blocks: Block[] = [];
      collect(new DOMParser().parseFromString(piece, "text/html").body, lang, () => {}, (b) => blocks.push(b));
      return blocks;
    })
    .filter((b) => b.length);
  // Page breaks are the fallback when the text has no chapter headings.
  const byBreaks = () =>
    pieces.length >= 3
      ? pieces.map((blocks, i) => {
          const h = blocks.find((b) => b.tag === "h");
          return { title: h ? textOf(h) : `Part ${i + 1}`, blocks };
        })
      : chunks(pieces.flat());
  return { title: title || baseName(name), author, chapters: chapterize(pieces.flat(), byBreaks) };
}

// Each text record may end with extra entries (flags in the MOBI header) that are not text.
function trailing(r: Uint8Array, flags: number): number {
  let n = 0;
  for (let bit = 1; bit < 16; bit++) {
    if (!(flags & (1 << bit))) continue;
    let size = 0, shift = 0;
    for (let j = r.length - n - 1; j >= Math.max(0, r.length - n - 4); j--) {
      const b = r[j];
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (b & 0x80) break;
    }
    n += size;
  }
  if (flags & 1) n += (r[r.length - n - 1] & 3) + 1;
  return n;
}

function palmdoc(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length * 8);
  let o = 0;
  for (let i = 0; i < src.length; ) {
    const c = src[i++];
    if (c >= 1 && c <= 8) for (let k = 0; k < c && i < src.length; k++) out[o++] = src[i++];
    else if (c < 0x80) out[o++] = c;
    else if (c >= 0xc0) (out[o++] = 0x20), (out[o++] = c ^ 0x80);
    else {
      const m = (c << 8) | src[i++];
      const dist = (m >> 3) & 0x7ff, len = (m & 7) + 3;
      for (let k = 0; k < len; k++, o++) out[o] = out[o - dist];
    }
  }
  return out.subarray(0, o);
}
