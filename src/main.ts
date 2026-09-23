import "./style.css";
import { parseEpub, type Book } from "./epub";
import { addBook, deleteBook, getBook, getMeta, listBooks, putMeta, type Meta } from "./db";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const lib = $("lib"), reader = $("reader"), status = $("status"), books = $("books");
const viewport = $("viewport"), content = $("content"), where = $("where");
const toc = $<HTMLSelectElement>("toc"), file = $<HTMLInputElement>("file");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (a: number, b: number) => (b ? Math.floor((100 * a) / b) : 0);
const pref = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
  return v ?? null;
};

function say(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// ---- Library ----

async function showLibrary() {
  reader.hidden = true;
  lib.hidden = false;
  const list = await listBooks();
  books.innerHTML = list.length ? "" : `<li class="sub">No books yet. Import an EPUB.</li>`;
  for (const m of list) {
    const li = document.createElement("li");
    li.innerHTML = `<button class="open"><div class="title">${esc(m.title)}</div>
      <div class="sub">${esc(m.author)}${m.author ? " &middot; " : ""}read ${pct(m.done, m.sentences)}% &middot; prepared ${m.prepared}%</div></button>
      <button class="del" aria-label="Delete">Delete</button>`;
    li.querySelector(".open")!.addEventListener("click", () => openBook(m.id));
    li.querySelector(".del")!.addEventListener("click", async () => {
      if (!confirm(`Delete "${m.title}" and all its data?`)) return;
      await deleteBook(m.id);
      showLibrary();
    });
    books.append(li);
  }
}

file.addEventListener("change", async () => {
  const f = file.files?.[0];
  file.value = "";
  if (!f) return;
  say(`Importing ${f.name}...`);
  try {
    const book = parseEpub(new Uint8Array(await f.arrayBuffer()));
    const m = await addBook(book);
    say(`Imported "${m.title}": ${book.chapters.length} chapters, ${m.sentences} sentences.`);
    showLibrary();
  } catch (e) {
    say(`Import failed: ${(e as Error).message || e}`, true);
  }
});

// ---- Reader ----

let book: Book;
let meta: Meta;
let ch = 0;
let page = 0;
let spans: HTMLElement[] = [];
// Sentences before each chapter, for whole-book progress.
let offsets: number[] = [];

const W = () => viewport.clientWidth;
const pages = () => Math.max(1, Math.round(viewport.scrollWidth / W()));
const pageOf = (el: Element) => Math.floor((el.getBoundingClientRect().left - content.getBoundingClientRect().left) / W());

async function openBook(id: string) {
  const [b, m] = await Promise.all([getBook(id), getMeta(id)]);
  if (!b || !m) return say("Book not found in storage.", true);
  book = b;
  meta = m;
  offsets = [];
  let n = 0;
  for (const c of book.chapters) {
    offsets.push(n);
    n += c.blocks.reduce((k, bl) => k + bl.sentences.length, 0);
  }
  toc.innerHTML = book.chapters.map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join("");
  lib.hidden = true;
  reader.hidden = false;
  showChapter(Math.min(meta.pos.ch, book.chapters.length - 1), meta.pos.s);
}

function showChapter(i: number, sentence: number | "end" = 0) {
  ch = i;
  toc.value = String(i);
  let s = 0;
  content.innerHTML = book.chapters[i].blocks
    .map((b) => {
      const inner = b.sentences.map((t) => `<span class="s" data-s="${s++}">${esc(t)}</span>`).join(" ");
      return b.tag === "h" ? `<h2>${inner}</h2>` : b.tag === "q" ? `<blockquote>${inner}</blockquote>` : `<p class="${b.tag}">${inner}</p>`;
    })
    .join("");
  spans = [...content.querySelectorAll<HTMLElement>(".s")];
  goto(sentence === "end" ? pages() - 1 : spans[sentence] ? pageOf(spans[sentence]) : 0);
}

// Last sentence that starts on or before this page: what the reader is looking at.
function anchor(): number {
  let lo = 0, hi = spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pageOf(spans[mid]) <= page) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function goto(p: number) {
  page = Math.max(0, Math.min(p, pages() - 1));
  viewport.scrollLeft = page * W();
  const s = anchor();
  meta.pos = { ch, s };
  meta.done = offsets[ch] + s;
  where.textContent = `${book.chapters[ch].title} · page ${page + 1}/${pages()} · ${pct(meta.done, meta.sentences)}%`;
  putMeta(meta);
}

function turn(dir: 1 | -1) {
  if (dir > 0 && page >= pages() - 1) {
    if (ch < book.chapters.length - 1) showChapter(ch + 1);
  } else if (dir < 0 && page === 0) {
    if (ch > 0) showChapter(ch - 1, "end");
  } else goto(page + dir);
}

// Re-layout keeps the current sentence on screen.
function relayout() {
  if (reader.hidden) return;
  const s = meta.pos.s;
  viewport.scrollLeft = 0;
  goto(spans[s] ? pageOf(spans[s]) : 0);
}

let down: { x: number; y: number } | null = null;
viewport.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
viewport.addEventListener("pointerup", (e) => {
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  down = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) return turn(dx < 0 ? 1 : -1);
  const x = e.clientX / W();
  if (x < 0.3) turn(-1);
  else if (x > 0.7) turn(1);
});
document.addEventListener("keydown", (e) => {
  if (reader.hidden) return;
  if (e.key === "ArrowRight" || e.key === " ") turn(1);
  if (e.key === "ArrowLeft") turn(-1);
});
addEventListener("resize", relayout);

toc.addEventListener("change", () => showChapter(Number(toc.value)));
$("back").addEventListener("click", showLibrary);

function setFont(px: number) {
  px = Math.max(14, Math.min(34, px));
  document.documentElement.style.setProperty("--font", `${px}px`);
  pref("font", String(px));
  relayout();
}
$("smaller").addEventListener("click", () => setFont(Number(pref("font") || 20) - 2));
$("bigger").addEventListener("click", () => setFont(Number(pref("font") || 20) + 2));
$("theme").addEventListener("click", () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  document.documentElement.dataset.theme = pref("theme", dark ? "light" : "dark")!;
});

document.documentElement.style.setProperty("--font", `${pref("font") || 20}px`);
navigator.storage?.persist?.();
showLibrary();
