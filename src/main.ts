import "./style.css";
import { parseEpub, type Book } from "./epub";
import { addBook, cached, cacheGet, cacheGetMany, cacheSet, deleteBook, getBook, getMeta, listBooks, putMeta, type Meta } from "./db";
import * as lr from "./lr";
import { drop, enqueue, flush, type Entry } from "./outbox";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const lib = $("lib"), reader = $("reader"), status = $("status"), books = $("books");
const viewport = $("viewport"), content = $("content"), where = $("where"), syncEl = $("sync"), sheet = $("sheet");
const toc = $<HTMLSelectElement>("toc"), file = $<HTMLInputElement>("file"), settingsDlg = $<HTMLDialogElement>("settings");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (a: number, b: number) => (b ? Math.floor((100 * a) / b) : 0);
const msg = (e: unknown) => (e as Error)?.message || String(e);
const pref = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
  return v ?? null;
};

type Settings = { email: string; token: string; sl: string; tl: string };
const settings = (): Settings => ({ email: "", token: "", sl: "es", tl: "uk", ...JSON.parse(pref("settings") || "{}") });
const lang = (): lr.Lang => ({ sl: settings().sl, tl: settings().tl });
const auth = (): lr.Auth | null => {
  const s = settings();
  return s.email && s.token ? { email: s.email, token: s.token } : null;
};

function say(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// ---- Saved words and outbox ----

let synced: Record<string, lr.Stage> = {};
let outbox: Entry[] = [];
let syncError = "";
const lemmaOf = (key: string) => key.split("|")[1];

// Pending marks win over the synced list until they are sent.
function stageOf(lemma: string): lr.Stage | undefined {
  const e = outbox.find((x) => lemmaOf(x.key) === lemma);
  if (e) return e.op === "save" ? e.item.learningStage : undefined;
  return synced[lemma];
}

function renderSync() {
  const failed = outbox.filter((e) => e.error);
  syncEl.classList.toggle("error", !!(failed.length || syncError));
  syncEl.textContent = syncError
    ? `\u00b7 ${syncError}`
    : failed.length
      ? `\u00b7 ${failed.length} not synced: ${failed[0].error}`
      : outbox.length
        ? `\u00b7 ${outbox.length} to sync`
        : "";
  $("sync-detail").textContent = outbox.length ? `Outbox: ${outbox.map((e) => `${e.op} ${lemmaOf(e.key)}${e.error ? ` (${e.error}, ${e.attempts} tries)` : ""}`).join("; ")}` : "Outbox empty.";
}

async function loadWords() {
  const s = settings();
  synced = (await cacheGet<Record<string, lr.Stage>>(`keys|${s.sl}`)) || {};
  outbox = (await cacheGet<Entry[]>("outbox")) || [];
  const a = auth();
  syncError = a ? "" : "set Language Reactor email and token in Settings";
  if (a && navigator.onLine) {
    try {
      synced = await lr.itemKeys(a, s.sl);
      await cacheSet(`keys|${s.sl}`, synced);
    } catch (e) {
      syncError = `word list: ${msg(e)}`;
    }
  }
  renderSync();
  mark();
  flushOutbox();
}

const chatRef = (index: number): lr.Ref => ({ refVersion: 2, source: "CHAT", diocoDocId: null, diocoDocName: null, diocoPlaylistId: null, diocoPlaylistName: null, subtitleIndex: index });

// A made-up USER_TEXT document id may be rejected; CHAT needs no document, so fall back once and remember.
async function saveWithFallback(a: lr.Auth, item: any) {
  try {
    await lr.saveItem(a, item);
  } catch (e) {
    if (item.source !== "USER_TEXT" || /unreachable/.test(msg(e))) throw e;
    const ref = chatRef(item.context.phrase.reference.subtitleIndex);
    await lr.saveItem(a, { ...item, source: "CHAT", context: { ...item.context, phrase: { ...item.context.phrase, reference: ref } } });
    pref("ref", "CHAT");
  }
}

let flushing = false;
async function flushOutbox() {
  const a = auth();
  if (flushing || !a || !outbox.length || !navigator.onLine) return renderSync();
  flushing = true;
  const sent = outbox;
  const left = await flush(sent, async (e) => {
    if (e.op === "save") {
      await saveWithFallback(a, e.item);
      synced[lemmaOf(e.key)] = e.item.learningStage;
    } else {
      await lr.removeItem(a, e.key);
      delete synced[lemmaOf(e.key)];
    }
  });
  // Marks made while sending replace whatever was sent or failed for the same word.
  const added = outbox.filter((e) => !sent.includes(e));
  outbox = [...left.filter((e) => !added.some((x) => x.key === e.key)), ...added];
  flushing = false;
  await Promise.all([cacheSet("outbox", outbox), cacheSet(`keys|${settings().sl}`, synced)]);
  renderSync();
  mark();
  if (added.length) flushOutbox();
}

addEventListener("online", loadWords);
addEventListener("offline", renderSync);

// ---- Settings ----

$("open-settings").addEventListener("click", async () => {
  const s = settings();
  for (const k of ["email", "token", "sl", "tl"] as const) (settingsDlg.querySelector(`[name=${k}]`) as HTMLInputElement).value = s[k];
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $("storage").textContent = est ? `Storage: ${((est.usage || 0) / 1e6).toFixed(1)} MB used of ${((est.quota || 0) / 1e6).toFixed(0)} MB${persisted ? ", persistent" : ", not persistent"}.` : "";
  renderSync();
  settingsDlg.showModal();
});
settingsDlg.addEventListener("close", () => {
  if (settingsDlg.returnValue !== "save") return;
  const v = (k: string) => (settingsDlg.querySelector(`[name=${k}]`) as HTMLInputElement).value.trim();
  pref("settings", JSON.stringify({ email: v("email"), token: v("token"), sl: v("sl") || "es", tl: v("tl") || "uk" }));
  loadWords();
});

// ---- Library ----

async function showLibrary() {
  closeSheet();
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
    const book = parseEpub(new Uint8Array(await f.arrayBuffer()), settings().sl);
    const m = await addBook(book);
    say(`Imported "${m.title}": ${book.chapters.length} chapters, ${m.sentences} sentences.`);
    showLibrary();
  } catch (e) {
    say(`Import failed: ${msg(e)}`, true);
  }
});

// ---- Reader ----

let book: Book;
let meta: Meta;
let ch = 0;
let page = 0;
let spans: HTMLElement[] = [];
// Sentences before each chapter, for whole-book progress and the sentence index sent to Language Reactor.
let offsets: number[] = [];
// Current chapter's sentences and their cached translations, by index within the chapter.
let sents: string[] = [];
let trs: (lr.Translated | undefined)[] = [];

const W = () => viewport.clientWidth;
const pages = () => Math.max(1, Math.round(viewport.scrollWidth / W()));
const pageOf = (el: Element) => Math.floor((el.getBoundingClientRect().left - content.getBoundingClientRect().left) / W());
const trKey = (text: string) => `tr|${settings().sl}|${settings().tl}|${text}`;

const WORD = /[\p{L}\p{M}\p{N}]+(?:['\u2019-][\p{L}\p{M}\p{N}]+)*/gu;
function wordSpans(text: string) {
  let out = "", last = 0;
  for (const m of text.matchAll(WORD)) {
    out += esc(text.slice(last, m.index)) + `<span class="w" data-o="${m.index}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// Index of the NLP token covering a character offset of the sentence; tolerant of spacing differences.
function tokenAt(nlp: lr.Token[], text: string, offset: number): number {
  let pos = 0;
  for (let i = 0; i < nlp.length; i++) {
    const f = nlp[i].form.text;
    if (!f.trim()) continue;
    const at = text.indexOf(f, pos);
    if (at < 0) continue;
    if (offset >= at && offset < at + f.length) return i;
    if (at > offset) return -1;
    pos = at + f.length;
  }
  return -1;
}

function lemmaFor(w: HTMLElement): { lemma: string; token?: lr.Token; index: number } {
  const si = Number((w.parentElement as HTMLElement).dataset.s);
  const tr = trs[si];
  const i = tr ? tokenAt(tr.nlp, sents[si], Number(w.dataset.o)) : -1;
  const token = tr?.nlp[i];
  return { lemma: (token?.lemma?.text || w.textContent!).toLowerCase(), token, index: i };
}

function mark() {
  if (reader.hidden) return;
  for (const w of content.querySelectorAll<HTMLElement>(".w")) {
    const { lemma } = lemmaFor(w);
    w.classList.toggle("learning", stageOf(lemma) === "LEARNING");
  }
}

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
  closeSheet();
  ch = i;
  toc.value = String(i);
  sents = book.chapters[i].blocks.flatMap((b) => b.sentences);
  trs = [];
  loaded = false;
  let s = 0;
  content.innerHTML = book.chapters[i].blocks
    .map((b) => {
      const inner = b.sentences.map((t) => `<span class="s" data-s="${s++}">${wordSpans(t)}</span>`).join(" ");
      return b.tag === "h" ? `<h2>${inner}</h2>` : b.tag === "q" ? `<blockquote>${inner}</blockquote>` : `<p class="${b.tag}">${inner}</p>`;
    })
    .join("");
  spans = [...content.querySelectorAll<HTMLElement>(".s")];
  goto(sentence === "end" ? pages() - 1 : spans[sentence] ? pageOf(spans[sentence]) : 0);
  const shown = ch;
  cacheGetMany<lr.Translated>(sents.map(trKey)).then((all) => {
    if (ch !== shown) return;
    trs = all.map((v, k) => v ?? trs[k]);
    loaded = true;
    mark();
    translatePage();
  });
}

// First sentence starting on this page or later.
function firstFrom(p: number): number {
  let lo = 0, hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pageOf(spans[mid]) >= p) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// The sentence the reader is looking at: the first one starting on this page, else the one running into it.
function anchor(): number {
  const f = firstFrom(page);
  return f < spans.length && pageOf(spans[f]) === page ? f : Math.max(0, f - 1);
}

function goto(p: number) {
  page = Math.max(0, Math.min(p, pages() - 1));
  viewport.scrollLeft = page * W();
  const s = anchor();
  meta.pos = { ch, s };
  meta.done = offsets[ch] + s;
  where.textContent = `${book.chapters[ch].title} \u00b7 page ${page + 1}/${pages()} \u00b7 ${pct(meta.done, meta.sentences)}%`;
  putMeta(meta);
  translatePage();
}

// Translate what is on screen and the next page, so lemmas highlight and taps answer from cache.
let translating = false;
let again = false;
let loaded = false;
async function translatePage() {
  if (translating) return void (again = true);
  if (!loaded || !navigator.onLine || !spans.length) return;
  const want: number[] = [];
  for (let i = Math.max(0, firstFrom(page) - 1); i < spans.length && pageOf(spans[i]) <= page + 1; i++) if (!trs[i]) want.push(i);
  if (!want.length) return;
  translating = true;
  const shown = ch;
  try {
    while (want.length) {
      const batch: number[] = [];
      let len = 0;
      while (want.length && (len += sents[want[0]].length + 1) <= 500) batch.push(want.shift()!);
      if (!batch.length) batch.push(want.shift()!);
      const res = await lr.translate(batch.map((i) => sents[i]), lang());
      await Promise.all(res.map((r, k) => cacheSet(trKey(sents[batch[k]]), r)));
      if (ch !== shown) break;
      res.forEach((r, k) => (trs[batch[k]] = r));
    }
    mark();
  } catch (e) {
    where.textContent += ` \u00b7 translate: ${msg(e)}`;
  } finally {
    translating = false;
    if (again) {
      again = false;
      translatePage();
    }
  }
}

async function ensureTr(si: number): Promise<lr.Translated> {
  if (trs[si]) return trs[si]!;
  const [r] = await lr.translate([sents[si]], lang());
  await cacheSet(trKey(sents[si]), r);
  return (trs[si] = r);
}

function turn(dir: 1 | -1) {
  closeSheet();
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

// ---- Word sheet ----

let current: HTMLElement | null = null;
let audio: Promise<string> | null = null;

function closeSheet() {
  sheet.hidden = true;
  current?.classList.remove("on");
  current = null;
}

async function openWord(w: HTMLElement) {
  closeSheet();
  current = w;
  w.classList.add("on");
  const form = w.textContent!;
  const si = Number((w.parentElement as HTMLElement).dataset.s);
  const sl = settings().sl;
  audio = cached(`tts|${sl}|${form.toLowerCase()}`, () => lr.tts(form, sl));
  audio.catch(() => {});
  sheet.hidden = false;
  sheet.innerHTML = `<h3>${esc(form)}</h3><div class="tr">...</div>`;
  let err = "";
  let tr: lr.Translated | undefined;
  try {
    tr = await ensureTr(si);
  } catch (e) {
    err = `Sentence translation: ${msg(e)}`;
  }
  if (current !== w) return;
  mark();
  const { lemma, token } = lemmaFor(w);
  let entries: string[] = [];
  try {
    const t = token;
    entries = await cached(`hd|${sl}|${settings().tl}|${form.toLowerCase()}|${t?.lemma?.text || ""}|${t?.pos || ""}`, () => lr.hoverDict(form, t, lang()));
  } catch (e) {
    err ||= `Dictionary: ${msg(e)}`;
  }
  if (current !== w) return;
  const stage = stageOf(lemma);
  const btn = (s: string, label: string) => `<button data-stage="${s}" class="${stage === s ? "on" : ""}">${label}</button>`;
  sheet.innerHTML = `<h3>${esc(form)}</h3>
    ${lemma !== form.toLowerCase() || token?.pos ? `<div class="lemma">${lemma !== form.toLowerCase() ? esc(lemma) + " &middot; " : ""}${esc((token?.pos || "").toLowerCase())}</div>` : ""}
    <div class="tr">${entries.length ? entries.map(esc).join(", ") : err ? "" : "no translation"}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <div class="act">${btn("LEARNING", "Learning")}${btn("KNOWN", "Known")}<button data-act="say">Play</button><button data-act="more">More</button></div>
    <div id="more"></div>
    <div class="sent">${esc(sents[si])}<b>${tr ? esc(tr.tr) : ""}</b></div>`;
}

function setStage(stage: lr.Stage) {
  const w = current;
  if (!w) return;
  const si = Number((w.parentElement as HTMLElement).dataset.s);
  const { lemma, index } = lemmaFor(w);
  const key = lr.wordKey(lemma, settings().sl);
  const next = stageOf(lemma) === stage ? undefined : stage;
  if (!next) {
    outbox = lemma in synced ? enqueue(outbox, "remove", key) : drop(outbox, key);
  } else {
    const tr = trs[si];
    if (!tr || index < 0) {
      sheet.querySelector(".tr")!.insertAdjacentHTML("afterend", `<div class="err">This sentence has no translation yet; connect once to translate it.</div>`);
      return;
    }
    const index0 = offsets[ch] + si;
    const ref = pref("ref") === "CHAT" ? chatRef(index0) : lr.bookRef(meta.id, meta.title, settings().sl, index0);
    const context: lr.Context = { text: sents[si], tr: tr.tr, nlp: tr.nlp, prev: sents[si - 1] ?? null, next: sents[si + 1] ?? null, ref };
    outbox = enqueue(outbox, "save", key, lr.wordItem(lemma, next, index, context, lang()));
  }
  cacheSet("outbox", outbox);
  sheet.querySelectorAll<HTMLElement>("[data-stage]").forEach((b) => b.classList.toggle("on", b.dataset.stage === next));
  mark();
  renderSync();
  flushOutbox();
}

async function more() {
  const w = current;
  if (!w) return;
  const box = $("more");
  const form = w.textContent!;
  const { token } = lemmaFor(w);
  box.textContent = "...";
  try {
    const s = settings();
    const entries = await cached(`fd|${s.sl}|${s.tl}|${form.toLowerCase()}|${token?.lemma?.text || ""}|${token?.pos || ""}`, () => lr.fullDict(form, token, lang()));
    box.innerHTML = entries
      .map((e) => `<div class="pos">${esc(e.word)}</div>` + e.posGroups.filter((g) => g.translations.length).map((g) => `<div><i>${esc((g.pos || "other").toLowerCase())}</i> ${g.translations.map(esc).join(", ")}</div>`).join(""))
      .join("") || "no entry";
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(msg(e))}</div>`;
  }
}

async function play() {
  try {
    await new Audio(await audio!).play();
  } catch (e) {
    sheet.insertAdjacentHTML("beforeend", `<div class="err">Play: ${esc(msg(e))}</div>`);
  }
}

sheet.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.stage) setStage(b.dataset.stage as lr.Stage);
  if (b.dataset.act === "say") play();
  if (b.dataset.act === "more") more();
});

// ---- Input ----

let down: { x: number; y: number } | null = null;
viewport.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
viewport.addEventListener("pointerup", (e) => {
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  down = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) return turn(dx < 0 ? 1 : -1);
  const w = (e.target as HTMLElement).closest<HTMLElement>(".w");
  if (w) return w === current ? closeSheet() : void openWord(w);
  if (!sheet.hidden) return closeSheet();
  const x = e.clientX / W();
  if (x < 0.3) turn(-1);
  else if (x > 0.7) turn(1);
});
document.addEventListener("keydown", (e) => {
  if (reader.hidden || settingsDlg.open) return;
  if (e.key === "ArrowRight" || e.key === " ") turn(1);
  if (e.key === "ArrowLeft") turn(-1);
  if (e.key === "Escape") closeSheet();
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
loadWords();
