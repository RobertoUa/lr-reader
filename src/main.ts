import "./style.css";
import { parseEpub, type Book } from "./epub";
import { addBook, cached, hdKey, hdLemmaKey, trKey as dbTrKey, cacheGet, cacheGetMany, cacheSet, deleteBook, getBook, getMeta, listBooks, putMeta, type Meta } from "./db";
import * as lr from "./lr";
import { drop, enqueue, flush, type Entry } from "./outbox";
import * as Look from "./look";
import { chapterSentences, prepareBook, type Progress } from "./prepare";

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

type Settings = { email: string; token: string; sl: string; tl: string; rate: string; voice: string; speechRate: string; autoSay: boolean };
const settings = (): Settings => ({ email: "", token: "", sl: "es", tl: "uk", rate: "4", voice: "", speechRate: "1", autoSay: true, ...JSON.parse(pref("settings") || "{}") });
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
  const key = lr.wordKey(lemma, settings().sl);
  const e = outbox.find((x) => x.key === key);
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
  $("sync-detail").textContent = outbox.length ? `Outbox: ${outbox.map((e) => `${e.op} ${e.item?.itemType === "PHRASE" ? `"${e.item.phrase ?? e.item.context.phrase.subtitles[1]}"` : lemmaOf(e.key)}${e.error ? ` (${e.error}, ${e.attempts} tries)` : ""}`).join("; ")}` : "Outbox empty.";
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
    if (item.source !== "USER_TEXT" || /unreachable|TOKEN_ERROR|RATE_LIMIT/.test(msg(e))) throw e;
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
      const item = e.item.draft ? await resolveDraft(e.item) : e.item;
      await saveWithFallback(a, item);
      if (item.itemType === "WORD") synced[lemmaOf(item.key)] = item.learningStage;
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
// iOS does not reliably fire "online" for a Home Screen app coming back, so also retry on return.
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && outbox.length && flushOutbox());

// A mark made before its sentence was translated (offline) is kept as a draft and completed here:
// the server needs the sentence's NLP tokens, and the word's dictionary form comes from them.
type Draft = { draft: true; itemType: "WORD" | "PHRASE"; learningStage: lr.Stage; offset?: number; phrase?: string; text: string; prev: string | null; next: string | null; ref: lr.Ref };

async function resolveDraft(d: Draft) {
  const tr = await cached(trKey(d.text), async () => (await lr.translate([d.text], lang()))[0]);
  const ctx: lr.Context = { ...d, tr: tr.tr, nlp: tr.nlp };
  if (d.itemType === "PHRASE") {
    const p = await cached(trKey(d.phrase!), async () => (await lr.translate([d.phrase!], lang()))[0]);
    return lr.phraseItem(d.phrase!, p.tr, p.nlp, ctx, lang());
  }
  const i = tokenAt(tr.nlp, d.text, d.offset!);
  if (i < 0) throw new Error(`could not find the word in "${d.text}"`);
  const lemma = (tr.nlp[i].lemma?.text || tr.nlp[i].form.text).toLowerCase();
  return lr.wordItem(lemma, d.learningStage, i, ctx, lang());
}
addEventListener("offline", renderSync);

// ---- Settings ----

$("open-settings").addEventListener("click", async () => {
  const s = settings();
  for (const k of ["email", "token", "sl", "tl", "rate", "speechRate"] as const) (settingsDlg.querySelector(`[name=${k}]`) as HTMLInputElement).value = s[k];
  (settingsDlg.querySelector("[name=autoSay]") as HTMLInputElement).checked = s.autoSay;
  fillVoices();
  const est = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  $("storage").textContent = est ? `Storage: ${((est.usage || 0) / 1e6).toFixed(1)} MB used of ${((est.quota || 0) / 1e6).toFixed(0)} MB${persisted ? ", persistent" : ", not persistent"}.` : "";
  renderSync();
  settingsDlg.showModal();
});
settingsDlg.addEventListener("close", () => {
  if (settingsDlg.returnValue !== "save") return;
  const v = (k: string) => (settingsDlg.querySelector(`[name=${k}]`) as HTMLInputElement).value.trim();
  const autoSay = (settingsDlg.querySelector("[name=autoSay]") as HTMLInputElement).checked;
  pref("settings", JSON.stringify({ email: v("email"), token: v("token"), sl: v("sl") || "es", tl: v("tl") || "uk", rate: v("rate") || "4", voice: v("voice"), speechRate: v("speechRate") || "1", autoSay }));
  loadWords();
});

// ---- Speech ----

// iOS plays audio only when it starts inside a tap. Language Reactor audio arrives later, so one player
// is unlocked during the tap with a moment of silence and reused for the real clip.
const player = new Audio();
const SILENCE = (() => {
  const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const tag = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  tag(0, "RIFF"), v.setUint32(4, 36 + n, true), tag(8, "WAVE"), tag(12, "fmt "), v.setUint32(16, 16, true);
  v.setUint16(20, 1, true), v.setUint16(22, 1, true), v.setUint32(24, 8000, true), v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true), v.setUint16(34, 8, true), tag(36, "data"), v.setUint32(40, n, true);
  b.fill(128, 44);
  return "data:audio/wav;base64," + btoa(String.fromCharCode(...b));
})();
const systemVoice = () => (settings().voice && speechSynthesis.getVoices().find((v) => v.voiceURI === settings().voice)) || null;

function fillVoices() {
  const sel = settingsDlg.querySelector("[name=voice]") as HTMLSelectElement;
  const sl = settings().sl;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(sl));
  sel.innerHTML = `<option value="">Language Reactor (online, cached)</option>` + voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join("");
  sel.value = settings().voice;
}
speechSynthesis.addEventListener?.("voiceschanged", () => settingsDlg.open && fillVoices());

// Must be called synchronously from a tap.
function speak(text: string, onError: (m: string) => void, voice = systemVoice(), rate = Number(settings().speechRate) || 1) {
  if (voice) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = rate;
    speechSynthesis.speak(u);
    return;
  }
  player.src = SILENCE;
  player.play().catch(() => {});
  const sl = settings().sl;
  cached(`tts|${sl}|${text.toLowerCase()}`, () => lr.tts(text, sl))
    .then((url) => {
      player.src = url;
      player.playbackRate = rate;
      return player.play();
    })
    .catch((e) => onError(`Play: ${msg(e)}`));
}

$("test-voice").addEventListener("click", (e) => {
  e.preventDefault();
  const sel = settingsDlg.querySelector("[name=voice]") as HTMLSelectElement;
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === sel.value) || null;
  const rate = Number((settingsDlg.querySelector("[name=speechRate]") as HTMLSelectElement).value) || 1;
  speak("Hola, \u00bfqu\u00e9 tal? Me gusta mucho leer libros en espa\u00f1ol.", (m) => ($("sync-detail").textContent = m), voice, rate);
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
      <div class="sub">${esc(m.author)}${m.author ? " &middot; " : ""}read ${pct(m.done, m.sentences)}% &middot; prepared ${m.prepared}%</div>
      <div class="sub prep"></div></button>
      <button class="prep-btn">${preparing?.id === m.id ? "Pause" : "Prepare"}</button>
      <button class="del" aria-label="Delete">Delete</button>`;
    li.querySelector(".prep-btn")!.addEventListener("click", () => (preparing?.id === m.id ? preparing.ctl.abort() : askPrepare(m.id)));
    if (preparing?.id === m.id) preparing.line = li.querySelector(".prep") as HTMLElement;
    li.querySelector(".open")!.addEventListener("click", () => openBook(m.id));
    li.querySelector(".del")!.addEventListener("click", async () => {
      if (!confirm(`Delete "${m.title}" and all its data?`)) return;
      if (preparing?.id === m.id) preparing.ctl.abort();
      await deleteBook(m.id);
      showLibrary();
    });
    books.append(li);
  }
}

// ---- Prepare for offline ----

let preparing: { id: string; ctl: AbortController; line: HTMLElement | null; text: string } | null = null;

function prepText(p: Progress) {
  return `chapter ${p.chapter}/${p.chapters} \u00b7 sentences ${p.sentences}/${p.sentencesTotal} \u00b7 words ${p.words}/${p.wordsSeen}`;
}

const prepDlg = $<HTMLDialogElement>("prepare");
const [prepFrom, prepTo] = [$<HTMLSelectElement>("prep-from"), $<HTMLSelectElement>("prep-to")];

async function askPrepare(id: string) {
  const [b, m] = await Promise.all([getBook(id), getMeta(id)]);
  if (!b || !m) return;
  const counts = chapterSentences(b);
  const done = new Set(m.preparedChapters || []);
  const opts = b.chapters.map((c, i) => `<option value="${i}">${i + 1}. ${esc(c.title)}${done.has(i) ? " \u2713" : ""}</option>`).join("");
  prepFrom.innerHTML = prepTo.innerHTML = opts;
  prepFrom.value = String(Math.min(m.pos.ch, b.chapters.length - 1));
  prepTo.value = String(b.chapters.length - 1);
  const info = () => {
    const [a, z] = [Number(prepFrom.value), Number(prepTo.value)].sort((x, y) => x - y);
    const n = counts.slice(a, z + 1).reduce((x, y) => x + y, 0);
    $("prep-info").textContent = `${z - a + 1} chapters, ${n} sentences. Already prepared chapters are skipped quickly.`;
  };
  prepFrom.onchange = prepTo.onchange = info;
  info();
  prepDlg.onclose = () => {
    if (prepDlg.returnValue !== "go") return;
    const [a, z] = [Number(prepFrom.value), Number(prepTo.value)].sort((x, y) => x - y);
    startPrepare(id, Array.from({ length: z - a + 1 }, (_, i) => a + i));
  };
  prepDlg.showModal();
}

async function startPrepare(id: string, chapters: number[]) {
  if (preparing) {
    preparing.ctl.abort();
    while (preparing) await new Promise((r) => setTimeout(r, 100));
  }
  const [b, m] = await Promise.all([getBook(id), getMeta(id)]);
  if (!b || !m) return;
  if (!navigator.onLine) return say("Preparing needs a connection.", true);
  preparing = { id, ctl: new AbortController(), line: null, text: "" };
  const job = preparing;
  navigator.storage?.persist?.();
  showLibrary();
  say(`Preparing "${m.title}" for offline. Keep the app open; it resumes where it stopped.`);
  const counts = chapterSentences(b);
  try {
    await prepareBook(b, chapters, lang(), Number(settings().rate) || 4, job.ctl.signal, (p) => {
      job.text = prepText(p);
      if (job.line) job.line.textContent = job.text;
    }, (ci) => chapterPrepared(id, ci, counts));
    say(`"${m.title}": chapters ${chapters[0] + 1}-${chapters[chapters.length - 1] + 1} are ready offline.`);
  } catch (e) {
    const paused = job.ctl.signal.aborted;
    say(paused ? `Paused "${m.title}": ${job.text}` : `Preparing "${m.title}" stopped: ${msg(e)}`, !paused);
  } finally {
    preparing = null;
    if (!lib.hidden) showLibrary();
  }
}

// The reader writes the same record (position), so read it fresh before changing it.
async function chapterPrepared(id: string, ci: number, counts: number[]) {
  const m = await getMeta(id);
  if (!m) return;
  const chs = [...new Set([...(m.preparedChapters || []), ci])];
  const total = counts.reduce((a, b) => a + b, 0);
  await putMeta({ ...m, preparedChapters: chs, prepared: Math.floor((100 * chs.reduce((n, i) => n + counts[i], 0)) / (total || 1)) });
}

file.addEventListener("change", async () => {
  const f = file.files?.[0];
  file.value = "";
  if (!f) return;
  say(`Importing ${f.name}...`);
  try {
    const data = new Uint8Array(await f.arrayBuffer());
    const isPdf = /\.pdf$/i.test(f.name) || f.type === "application/pdf";
    // pdf.js is large, so it loads only when a PDF is imported.
    const book = isPdf
      ? await (await import("./pdf")).parsePdf(data, f.name, settings().sl, (n, total) => say(`Importing ${f.name}: page ${n}/${total}...`))
      : parseEpub(data, settings().sl);
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
const trKey = (text: string) => dbTrKey(text, lang());

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
  chapterChars = book.chapters.map((c) => c.blocks.reduce((n, b) => n + b.sentences.reduce((m, t) => m + t.length + 1, 0), 0));
  measured.clear();
  bookSents = book.chapters.flatMap((c, ci) => c.blocks.flatMap((b) => b.sentences).map((text, si) => ({ ci, si, text })));
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
  content.lang = settings().sl;
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

// Only the open chapter is laid out, so the book-wide page number is estimated from characters per
// page, averaged over the chapters laid out since the last layout change (font, size, rotation).
let chapterChars: number[] = [];
const measured = new Map<number, number>();
function bookPage(): string {
  measured.set(ch, pages());
  let c = 0, p = 0;
  for (const [i, n] of measured) (c += chapterChars[i]), (p += n);
  const charsPerPage = c / p;
  const before = chapterChars.slice(0, ch).reduce((a, b) => a + b, 0);
  const total = chapterChars.reduce((a, b) => a + b, 0);
  const n = Math.round(before / charsPerPage) + page + 1;
  return ` \u00b7 p. ${n} of ${Math.max(n, Math.round(total / charsPerPage))}`;
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
  where.textContent = `${book.chapters[ch].title} \u00b7 ${page + 1}/${pages()}${bookPage()} \u00b7 ${pct(meta.done, meta.sentences)}%`;
  const { id, pos, done } = meta;
  getMeta(id).then((m) => m && putMeta({ ...m, pos, done }));
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
      const texts = batch.map((i) => sents[i]);
      const res = await lr.translate(texts, lang());
      await Promise.all(res.map((r, k) => cacheSet(trKey(texts[k]), r)));
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
  const text = sents[si], shown = ch;
  const [r] = await lr.translate([text], lang());
  await cacheSet(trKey(text), r);
  if (ch === shown) trs[si] = r;
  return r;
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
  measured.clear();
  const s = meta.pos.s;
  viewport.scrollLeft = 0;
  goto(spans[s] ? pageOf(spans[s]) : 0);
}

// ---- Word sheet ----

let current: HTMLElement | null = null;

function closeSheet() {
  sheet.hidden = true;
  lookPanel.hidden = true;
  current?.classList.remove("on");
  current = null;
  selected = [];
  content.querySelectorAll(".w.sel").forEach((x) => x.classList.remove("sel"));
}

async function openWord(w: HTMLElement) {
  closeSheet();
  current = w;
  w.classList.add("on");
  const form = w.textContent!;
  const si = Number((w.parentElement as HTMLElement).dataset.s);
  const sl = settings().sl;
  if (settings().autoSay) speak(form, sheetError);
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
    entries = await cached(hdKey(form, t, lang()), () => lr.hoverDict(form, t, lang()));
  } catch (e) {
    const byLemma = token && (await cacheGet<string[]>(hdLemmaKey(token, lang())));
    if (byLemma) entries = byLemma;
    else err ||= `Dictionary: ${msg(e)}`;
  }
  if (current !== w) return;
  const stage = stageOf(lemma);
  const btn = (s: string, label: string) => `<button data-stage="${s}" class="${stage === s ? "on" : ""}">${label}</button>`;
  sheet.innerHTML = `<h3>${esc(form)}</h3>
    ${lemma !== form.toLowerCase() || token?.pos ? `<div class="lemma">${lemma !== form.toLowerCase() ? esc(lemma) + " &middot; " : ""}${esc((token?.pos || "").toLowerCase())}</div>` : ""}
    <div class="tr">${entries.length ? entries.map(esc).join(", ") : err ? "" : "no translation"}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <div class="act">${btn("LEARNING", "Learning")}${btn("KNOWN", "Known")}<button data-act="say">Play</button><button data-act="say-sentence">Play sentence</button><button data-act="more">More</button><button data-act="examples">Show examples</button></div>
    <div id="more"></div>
    <div id="examples"></div>
    <div class="sent">${esc(sents[si])}<b>${tr ? esc(tr.tr) : ""}</b></div>`;
}

function where0(si: number) {
  const index0 = offsets[ch] + si;
  const ref = pref("ref") === "CHAT" ? chatRef(index0) : lr.bookRef(meta.id, meta.title, settings().sl, index0);
  return { text: sents[si], prev: sents[si - 1] ?? null, next: sents[si + 1] ?? null, ref };
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
    const draft: Draft = { draft: true, itemType: "WORD", learningStage: next, offset: Number(w.dataset.o), ...where0(si) };
    outbox = enqueue(outbox, "save", key, tr && index >= 0 ? lr.wordItem(lemma, next, index, { ...draft, tr: tr.tr, nlp: tr.nlp }, lang()) : draft);
  }
  cacheSet("outbox", outbox);
  sheet.querySelectorAll<HTMLElement>("[data-stage]").forEach((b) => b.classList.toggle("on", b.dataset.stage === next));
  mark();
  renderSync();
  flushOutbox();
}

// ---- Examples and search: sentences from the whole book ----

type Found = { ci: number; si: number; text: string };
let bookSents: Found[] = [];
const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(${words.map(reEsc).join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "giu");

function jumpTo(ci: number, si: number) {
  closeSheet();
  $("search-panel").hidden = true;
  showChapter(ci, si);
  const el = spans[si];
  el?.classList.add("flash");
  setTimeout(() => el?.classList.remove("flash"), 2500);
}

function foundList(hits: (Found & { tr?: string })[], mark: (text: string) => string) {
  return hits
    .map((h) => `<button class="found" data-ci="${h.ci}" data-si="${h.si}"><span>${mark(h.text)}</span>${h.tr ? `<i>${esc(h.tr)}</i>` : ""}<small>${esc(book.chapters[h.ci].title)}</small></button>`)
    .join("");
}

document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button.found");
  if (b) jumpTo(Number(b.dataset.ci), Number(b.dataset.si));
});

// Up to 5 other sentences with the same form or dictionary form, going forward from here.
async function examples() {
  const w = current;
  if (!w) return;
  const box = $("examples");
  const { lemma } = lemmaFor(w);
  const words = [...new Set([w.textContent!.toLowerCase(), lemma])];
  const re = wordRe(words);
  const here = offsets[ch] + Number((w.parentElement as HTMLElement).dataset.s);
  const seen = new Set([sents[Number((w.parentElement as HTMLElement).dataset.s)]]);
  const hits: (Found & { tr?: string })[] = [];
  for (let k = 1; k < bookSents.length && hits.length < 5; k++) {
    const x = bookSents[(here + k) % bookSents.length];
    re.lastIndex = 0;
    if (!seen.has(x.text) && re.test(x.text)) hits.push(x), seen.add(x.text);
  }
  const mark = (t: string) => esc(t).replace(wordRe(words.map(esc)), "<b>$1</b>");
  if (!hits.length) return void (box.innerHTML = `<div class="sub">No other sentences with "${esc(words.join('" or "'))}" in this book.</div>`);
  const cachedTrs = await cacheGetMany<lr.Translated>(hits.map((h) => trKey(h.text)));
  hits.forEach((h, i) => (h.tr = cachedTrs[i]?.tr));
  box.innerHTML = foundList(hits, mark);
  const missing = hits.filter((h) => !h.tr);
  if (!missing.length || !navigator.onLine) return;
  try {
    const res = await lr.translate(missing.map((h) => h.text), lang());
    await Promise.all(res.map((r, i) => cacheSet(trKey(missing[i].text), r)));
    missing.forEach((h, i) => (h.tr = res[i].tr));
    if (current === w) box.innerHTML = foundList(hits, mark);
  } catch (e) {
    box.insertAdjacentHTML("beforeend", `<div class="err">${esc(msg(e))}</div>`);
  }
}

const searchPanel = $("search-panel");
let searchTimer = 0;
$("search").addEventListener("click", () => {
  const open = searchPanel.hidden;
  closeSheet();
  searchPanel.hidden = !open;
  if (open) ($("search-input") as HTMLInputElement).focus();
});
$("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const q = fold(($("search-input") as HTMLInputElement).value.trim());
    const box = $("search-results");
    if (q.length < 2) return void (box.innerHTML = "");
    // Accent- and case-insensitive; folding keeps lengths for precomposed text, so offsets map back.
    const hits = bookSents.filter((x) => fold(x.text).includes(q));
    const mark = (t: string) => {
      const f = fold(t), i = f.indexOf(q);
      return f.length === t.length && i >= 0 ? esc(t.slice(0, i)) + `<b>${esc(t.slice(i, i + q.length))}</b>` + esc(t.slice(i + q.length)) : esc(t);
    };
    box.innerHTML = `<div class="sub">${hits.length} sentence${hits.length === 1 ? "" : "s"}${hits.length > 100 ? ", first 100 shown" : ""}</div>` + foundList(hits.slice(0, 100), mark);
  }, 250);
});

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

const sheetError = (m: string) => sheet.insertAdjacentHTML("beforeend", `<div class="err">${esc(m)}</div>`);

// The sheet shows either one word (current) or a selected phrase (selected).
function play(what: "say" | "say-sentence") {
  const first = current || selected[0];
  if (!first) return;
  const si = Number((first.parentElement as HTMLElement).dataset.s);
  const text = what === "say-sentence" ? sents[si] : current ? current.textContent! : phrase?.text || "";
  if (text) speak(text, sheetError);
}

// ---- Phrase selection: long-press a word, drag across others, release ----

let selected: HTMLElement[] = [];
let phrase: { text: string; tr: string; nlp: lr.Token[]; si: number } | null = null;

function selectRange(from: HTMLElement, to: HTMLElement) {
  const all = [...content.querySelectorAll<HTMLElement>(".w")];
  const [a, b] = [all.indexOf(from), all.indexOf(to)].sort((x, y) => x - y);
  selected = all.slice(a, b + 1);
  all.forEach((x, i) => x.classList.toggle("sel", i >= a && i <= b));
}

async function openPhrase() {
  const sel = selected;
  current?.classList.remove("on");
  current = null;
  // The exact text between the first and last word, punctuation included.
  const range = document.createRange();
  range.setStartBefore(sel[0]);
  range.setEndAfter(sel[sel.length - 1]);
  const text = range.toString().replace(/\s+/g, " ").trim();
  const si = Number((sel[0].parentElement as HTMLElement).dataset.s);
  const sl = settings().sl;
  phrase = null;
  sheet.hidden = false;
  sheet.innerHTML = `<h3>${esc(text)}</h3><div class="tr">...</div>`;
  let tr: lr.Translated | undefined;
  let err = "";
  try {
    tr = await cached(trKey(text), async () => (await lr.translate([text], lang()))[0]);
    await ensureTr(si);
  } catch (e) {
    err = `${msg(e)}. Save phrase still works; it is sent when you are back online.`;
  }
  if (selected !== sel) return;
  phrase = { text, tr: tr?.tr || "", nlp: tr?.nlp || [], si };
  const key = `PHRASE-YT|${sl}|${lr.md5(text).slice(0, 16)}`;
  const queued = outbox.some((x) => x.key === key);
  sheet.innerHTML = `<h3>${esc(text)}</h3>
    <div class="tr">${tr ? esc(tr.tr) : ""}</div>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    <div class="act"><button data-act="save-phrase" class="${queued ? "on" : ""}">${queued ? "Saved" : "Save phrase"}</button><button data-act="say">Play</button><button data-act="say-sentence">Play sentence</button></div>
    ${trs[si] ? `<div class="sent">${esc(sents[si])}<b>${esc(trs[si]!.tr)}</b></div>` : ""}`;
}

function savePhrase(b: HTMLElement) {
  if (!phrase) return;
  const tr = trs[phrase.si];
  const draft: Draft = { draft: true, itemType: "PHRASE", learningStage: "LEARNING", phrase: phrase.text, ...where0(phrase.si) };
  const item = tr && phrase.nlp.length ? lr.phraseItem(phrase.text, phrase.tr, phrase.nlp, { ...draft, tr: tr.tr, nlp: tr.nlp }, lang()) : draft;
  outbox = enqueue(outbox, "save", `PHRASE-YT|${settings().sl}|${lr.md5(phrase.text).slice(0, 16)}`, item);
  cacheSet("outbox", outbox);
  b.classList.add("on");
  b.textContent = "Saved";
  renderSync();
  flushOutbox();
}

sheet.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.act === "save-phrase") savePhrase(b);
  if (b.dataset.stage) setStage(b.dataset.stage as lr.Stage);
  if (b.dataset.act === "say" || b.dataset.act === "say-sentence") play(b.dataset.act);
  if (b.dataset.act === "more") more();
  if (b.dataset.act === "examples") examples();
});

// ---- Input ----

let down: { x: number; y: number } | null = null;
let press = 0;
let selFrom: HTMLElement | null = null;
const wordAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>("#content .w") || null;

viewport.addEventListener("pointerdown", (e) => {
  down = { x: e.clientX, y: e.clientY };
  selFrom = null;
  const w = (e.target as HTMLElement).closest<HTMLElement>(".w");
  clearTimeout(press);
  if (!w) return;
  press = window.setTimeout(() => {
    closeSheet();
    selFrom = w;
    viewport.setPointerCapture(e.pointerId);
    selectRange(w, w);
  }, 400);
});
viewport.addEventListener("pointermove", (e) => {
  if (selFrom) {
    const w = wordAt(e.clientX, e.clientY);
    if (w) selectRange(selFrom, w);
  } else if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 10) clearTimeout(press);
});
viewport.addEventListener("pointercancel", () => {
  clearTimeout(press);
  down = selFrom = null;
});
viewport.addEventListener("pointerup", (e) => {
  clearTimeout(press);
  if (selFrom) {
    selFrom = down = null;
    return void openPhrase();
  }
  if (!down) return;
  const dx = e.clientX - down.x, dy = e.clientY - down.y;
  down = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) return turn(dx < 0 ? 1 : -1);
  const w = (e.target as HTMLElement).closest<HTMLElement>(".w");
  if (w) return w === current ? closeSheet() : void openWord(w);
  if (!sheet.hidden || !lookPanel.hidden || !searchPanel.hidden) return closeSheet(), void (searchPanel.hidden = true);
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

const lookPanel = $("look-panel");
let look = Look.load();
Look.apply(look);
$("look").addEventListener("click", () => {
  if (!lookPanel.hidden) return void (lookPanel.hidden = true);
  closeSheet();
  lookPanel.innerHTML = Look.panel(look);
  lookPanel.hidden = false;
});
lookPanel.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  const next = b && Look.change(look, b);
  if (!next) return;
  look = next;
  Look.apply(look);
  lookPanel.innerHTML = Look.panel(look);
  relayout();
});

navigator.storage?.persist?.();
showLibrary();
loadWords();
