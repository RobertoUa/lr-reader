import { unzipSync, strFromU8 } from "fflate";
import { sentences } from "./split";

export type Block = { tag: "p" | "h" | "q" | "li"; sentences: string[] };
export type Chapter = { title: string; blocks: Block[] };
export type Book = { title: string; author: string; chapters: Chapter[] };

const BLOCKS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li", "dd", "dt", "pre", "td", "figcaption", "section", "article"]);
const SKIP = new Set(["script", "style", "head", "nav", "rt", "rp"]);

const resolve = (base: string, href: string) => decodeURIComponent(new URL(href, "http://x/" + base).pathname.slice(1));

function xml(text: string, type: DOMParserSupportedType = "application/xhtml+xml"): Document {
  const doc = new DOMParser().parseFromString(text, type);
  // Many real EPUBs have XHTML that is not well-formed XML; the HTML parser is forgiving.
  return doc.querySelector("parsererror") && type !== "text/html" ? xml(text, "text/html") : doc;
}

const tagOf = (name: string): Block["tag"] => (/^h\d$/.test(name) ? "h" : name === "blockquote" ? "q" : name === "li" ? "li" : "p");

// A block is an element with no block-level children; its text is split into sentences.
// onId sees every id on the way, so a chapter can start at a TOC fragment inside a file.
// ponytail: text sitting directly next to block siblings is dropped, rare in real books.
function collect(el: Element, lang: string, onId: (id: string) => void, out: (b: Block) => void) {
  const name = el.localName.toLowerCase();
  if (SKIP.has(name)) return;
  if (el.id) onId(el.id);
  const kids = [...el.children];
  if (kids.some((k) => BLOCKS.has(k.localName.toLowerCase()))) {
    for (const k of kids) collect(k, lang, onId, out);
    return;
  }
  for (const k of el.querySelectorAll("[id]")) onId(k.id);
  const s = sentences(el.textContent || "", lang);
  if (s.length) out({ tag: tagOf(name), sentences: s });
}

type TocEntry = { file: string; frag: string; title: string };

function readToc(files: Record<string, Uint8Array>, opf: Document, opfPath: string, items: Map<string, string>): TocEntry[] {
  const toc: TocEntry[] = [];
  const add = (base: string, href: string | null, label: string | null | undefined) => {
    const title = label?.replace(/\s+/g, " ").trim();
    if (!href || !title) return;
    const [path, frag = ""] = href.split("#");
    toc.push({ file: resolve(base, path), frag: decodeURIComponent(frag), title });
  };
  const navItem = [...opf.querySelectorAll("manifest > item")].find((i) => (i.getAttribute("properties") || "").split(" ").includes("nav"));
  const nav = navItem && resolve(opfPath, navItem.getAttribute("href")!);
  if (nav && files[nav]) {
    const doc = xml(strFromU8(files[nav]));
    const tocNav = [...doc.querySelectorAll("nav")].find((n) => n.getAttribute("epub:type") === "toc") || doc.querySelector("nav");
    for (const a of tocNav?.querySelectorAll("a") || []) add(nav, a.getAttribute("href"), a.textContent);
  }
  const ncxId = opf.querySelector("spine")?.getAttribute("toc");
  const ncx = ncxId && items.get(ncxId);
  if (!toc.length && ncx && files[ncx]) {
    for (const p of xml(strFromU8(files[ncx]), "application/xml").querySelectorAll("navPoint")) {
      add(ncx, p.querySelector("content")?.getAttribute("src") ?? null, p.querySelector("navLabel")?.textContent);
    }
  }
  return toc;
}

export function parseEpub(data: Uint8Array, lang = "es"): Book {
  const files = unzipSync(data);
  const container = xml(strFromU8(files["META-INF/container.xml"]), "application/xml");
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath || !files[opfPath]) throw new Error("Not an EPUB: no package document");
  const opf = xml(strFromU8(files[opfPath]), "application/xml");
  const items = new Map([...opf.querySelectorAll("manifest > item")].map((i) => [i.getAttribute("id")!, resolve(opfPath, i.getAttribute("href")!)]));
  const toc = readToc(files, opf, opfPath, items);
  const navFile = [...opf.querySelectorAll("manifest > item")].find((i) => (i.getAttribute("properties") || "").split(" ").includes("nav"));
  const skip = navFile && resolve(opfPath, navFile.getAttribute("href")!);
  // With a usable TOC, chapters are its entries (a file can hold many, or one entry can span files);
  // otherwise each spine file is a chapter.
  const byToc = toc.length > 1;

  const chapters: Chapter[] = [];
  let cur: Chapter | null = null;
  const start = (title: string) => {
    if (cur && !cur.blocks.length) cur.title = cur.title || title;
    else chapters.push((cur = { title, blocks: [] }));
  };
  for (const ref of opf.querySelectorAll("spine > itemref")) {
    const path = items.get(ref.getAttribute("idref")!);
    if (!path || !files[path] || path === skip) continue;
    const doc = xml(strFromU8(files[path]));
    const here = toc.filter((t) => t.file === path);
    const whole = here.find((t) => !t.frag);
    if (!byToc || whole || !cur) start(whole?.title || "");
    const frags = new Map(here.filter((t) => t.frag).map((t) => [t.frag, t.title]));
    const body = doc.body || doc.documentElement;
    collect(body, lang, (id) => {
      const title = frags.get(id);
      if (title !== undefined) {
        frags.delete(id);
        start(title);
      }
    }, (b) => cur!.blocks.push(b));
  }
  const kept = chapters.filter((c) => c.blocks.length);
  for (const [i, c] of kept.entries()) c.title ||= c.blocks.find((b) => b.tag === "h")?.sentences.join(" ") || `Chapter ${i + 1}`;
  if (!kept.length) throw new Error("No readable text in this EPUB");

  const meta = (tag: string) => opf.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", tag)[0]?.textContent?.trim() || "";
  return { title: meta("title") || "Untitled", author: meta("creator"), chapters: kept };
}
