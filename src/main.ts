import "./style.css";
import { parseEpub, type Book } from "./epub";
import { type Bookmark, addBook, clearTranslations, getCacheByPrefix, putBook, setCacheMany, cached, hdKey, hdLemmaKey, cacheGet, cacheGetMany, cacheSet, deleteBook, getBook, getMeta, listBooks, putMeta, type Meta } from "./db";
import * as lr from "./lr";
import { afterFlush, drop, enqueue, flush, type Entry } from "./outbox";
import * as Look from "./look";
import * as Sum from "./summary";
import * as S from "./source";
import * as MT from "./mt";
import * as Study from "./study";
import * as Freq from "./freq";
import { synonyms as aiSynonyms } from "./aitr";
import bookmarkletSrc from "./bookmarklet.js?raw";
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

type Settings = { email: string; token: string; sl: string; tl: string; rate: string; voice: string; speechRate: string; autoSay: boolean; claudeKey: string; claudeModel: string; openaiKey: string; openaiModel: string; trSource: string; trModelOpenai: string; trModelClaude: string };
// Parsed once per change: mark() asks for it for every word.
let settingsRaw: string | null = null, settingsVal: Settings;
const settings = (): Settings => {
  const raw = pref("settings");
  if (raw !== settingsRaw || !settingsVal) {
    settingsRaw = raw;
    settingsVal = { email: "", token: "", sl: "es", tl: "uk", rate: "4", voice: "", speechRate: "1", autoSay: true, claudeKey: "", claudeModel: "claude-opus-5", openaiKey: "", openaiModel: "gpt-5.5", trSource: "lr", trModelOpenai: "gpt-5.4-mini", trModelClaude: "claude-opus-5", ...JSON.parse(raw || "{}") };
  }
  return settingsVal;
};
const lang = (): lr.Lang => ({ sl: settings().sl, tl: settings().tl });
// Translations and dictionary data: Language Reactor, or ChatGPT/Claude with the user's key.
function source(): S.Source {
  const s = settings();
  if (s.trSource === "openai") return S.aiSource({ provider: "openai", key: s.openaiKey, model: s.trModelOpenai });
  if (s.trSource === "claude") return S.aiSource({ provider: "claude", key: s.claudeKey, model: s.trModelClaude });
  return S.LR;
}
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

// Pending marks win over the synced list until they are sent. A mark made offline before the sentence
// was translated is keyed by the word as written, so it is looked up under that form too.
// The outbox is replaced, never mutated, so its key index is rebuilt only when it changes.
let byKeyFor: Entry[] | null = null, byKey = new Map<string, Entry>();
function stageOf(lemma: string, form = lemma, sl = settings().sl): lr.Stage | undefined {
  if (byKeyFor !== outbox) (byKey = new Map(outbox.map((e) => [e.key, e]))), (byKeyFor = outbox);
  const draft = form !== lemma ? byKey.get(lr.wordKey(form, sl)) : undefined;
  const e = byKey.get(lr.wordKey(lemma, sl)) || (draft?.item?.draft ? draft : undefined);
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

let outboxLoaded = false;
async function loadWords() {
  const s = settings();
  // In memory the outbox is the truth; reloading it mid-flush would resend what was just sent.
  if (!outboxLoaded) {
    outbox = (await cacheGet<Entry[]>("outbox")) || [];
    outboxLoaded = true;
  }
  if (flushing) return;
  synced = (await cacheGet<Record<string, lr.Stage>>(`keys|${s.sl}`)) || {};
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

// A made-up USER_TEXT document id may be rejected (BAD_REQUEST); CHAT needs no document, so fall back
// once and remember. Other errors (server hiccups, token, rate limit) must not flip it for good.
async function saveWithFallback(a: lr.Auth, item: any) {
  try {
    await lr.saveItem(a, item);
  } catch (e) {
    if (item.source !== "USER_TEXT" || !/BAD_REQUEST/.test(msg(e))) throw e;
    const ref = chatRef(item.context.phrase.reference.subtitleIndex);
    await lr.saveItem(a, { ...item, source: "CHAT", context: { ...item.context, phrase: { ...item.context.phrase, reference: ref } } });
    pref("ref", "CHAT");
  }
}

let flushing = false;
// Keys whose request is on the wire: undoing one of those needs a remove, not just dropping the entry.
const sending = new Set<string>();
async function flushOutbox() {
  const a = auth();
  const mine = outbox.filter((e) => (e.account ?? a?.email) === a?.email);
  if (flushing || !a || !mine.length || !navigator.onLine) return renderSync();
  flushing = true;
  const startIds = new Set(outbox.map((e) => e.id));
  mine.forEach((e) => sending.add(e.key));
  const left = await flush(mine, async (e) => {
    if (e.op === "save") {
      const item = e.item.draft ? await resolveDraft(e.item) : e.item;
      await saveWithFallback(a, item);
      if (item.itemType === "WORD") synced[lemmaOf(item.key)] = item.learningStage;
    } else {
      await lr.removeItem(a, e.key);
      delete synced[lemmaOf(e.key)];
    }
  });
  outbox = afterFlush(outbox, mine, left);
  // Only marks made during this flush start another one; failures wait for the next trigger.
  const added = outbox.filter((e) => !startIds.has(e.id));
  sending.clear();
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
  const tr = await translateCached(d.text);
  const ctx: lr.Context = { ...d, tr: tr.tr, nlp: tr.nlp };
  if (d.itemType === "PHRASE") {
    const p = await translateCached(d.phrase!);
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
  const opts = (m: Record<string, string>) => Object.entries(m).map(([id, n]) => `<option value="${id}">${n}</option>`).join("");
  ($("settings").querySelector("[name=claudeModel]") as HTMLSelectElement).innerHTML = opts(Sum.CLAUDE_MODELS);
  ($("settings").querySelector("[name=openaiModel]") as HTMLSelectElement).innerHTML = opts(Sum.OPENAI_MODELS);
  ($("settings").querySelector("[name=trModelOpenai]") as HTMLSelectElement).innerHTML = opts(TR_OPENAI);
  ($("settings").querySelector("[name=trModelClaude]") as HTMLSelectElement).innerHTML = opts(Sum.CLAUDE_MODELS);
  for (const k of ["email", "token", "sl", "tl", "rate", "speechRate", "claudeKey", "claudeModel", "openaiKey", "openaiModel", "trSource", "trModelOpenai", "trModelClaude"] as const) (settingsDlg.querySelector(`[name=${k}]`) as HTMLInputElement).value = s[k];
  (settingsDlg.querySelector("[name=autoSay]") as HTMLInputElement).checked = s.autoSay;
  fillVoices();
  mtStatus();
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
  pref("settings", JSON.stringify({ email: v("email"), token: v("token"), sl: v("sl") || "es", tl: v("tl") || "uk", rate: v("rate") || "4", voice: v("voice"), speechRate: v("speechRate") || "1", autoSay, claudeKey: v("claudeKey"), claudeModel: v("claudeModel") || "claude-opus-5", openaiKey: v("openaiKey"), openaiModel: v("openaiModel") || "gpt-5.5", trSource: v("trSource") || "lr", trModelOpenai: v("trModelOpenai") || "gpt-5.4-mini", trModelClaude: v("trModelClaude") || "claude-opus-5" }));
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

// iOS gives a downloaded Enhanced or Premium voice the same name as its compact one; only the URI differs.
const voiceRank = (v: SpeechSynthesisVoice) => (/premium/i.test(v.voiceURI) ? 2 : /enhanced/i.test(v.voiceURI) ? 1 : 0);
const voiceLabel = (v: SpeechSynthesisVoice) => {
  const q = ["", "Enhanced", "Premium"][voiceRank(v)];
  return `${v.name}${q && !v.name.includes(q) ? ` (${q})` : ""} - ${v.lang}`;
};

function fillVoices() {
  const sel = settingsDlg.querySelector("[name=voice]") as HTMLSelectElement;
  const sl = settings().sl;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(sl)).sort((a, b) => voiceRank(b) - voiceRank(a));
  sel.innerHTML = `<option value="">Language Reactor (online, cached)</option>` + voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(voiceLabel(v))}</option>`).join("");
  sel.value = settings().voice;
}
speechSynthesis.addEventListener?.("voiceschanged", () => settingsDlg.open && fillVoices());

// Language Reactor's speech endpoint answers BAD_REQUEST above 30 characters, so longer text needs a
// device voice even when Language Reactor is the chosen voice.
const LR_TTS_MAX = 30;
function deviceVoice() {
  const sl = settings().sl;
  const all = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(sl));
  const best = Math.max(0, ...all.map(voiceRank));
  const top = all.filter((v) => voiceRank(v) === best);
  return top.find((v) => v.default) || top.find((v) => v.lang.toLowerCase() === `${sl}-${sl}`) || top[0] || null;
}

// Must be called synchronously from a tap.
function speak(text: string, onError: (m: string) => void, voice = systemVoice(), rate = Number(settings().speechRate) || 1) {
  if (!voice && text.length > LR_TTS_MAX) {
    voice = deviceVoice();
    if (!voice) return onError("Language Reactor can only say short words; this device has no voice for the book language.");
  }
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

const TR_OPENAI: Record<string, string> = { "gpt-5.4-mini": "GPT-5.4 mini (fast, cheap)", "gpt-5.5": "GPT-5.5", "gpt-6-sol": "GPT-6 Sol" };

function mtStatus() {
  $("mt-status").textContent = !MT.supported(settings().sl)
    ? "Only for Spanish books."
    : pref("mtReady") === "1"
      ? "Downloaded: unprepared sentences get an English translation offline."
      : "Not downloaded. About 110 MB, once, over Wi-Fi.";
}
$("clear-translations").addEventListener("click", async () => {
  if (!confirm("Remove all cached translations and word lookups? Prepared chapters will need preparing again.")) return;
  const n = await clearTranslations();
  await Promise.all((await listBooks()).map((m) => putMeta({ ...m, prepared: 0, preparedChapters: [] })));
  trs = [];
  $("clear-status").textContent = `Removed ${n} cached entries.`;
  if (!lib.hidden) showLibrary();
});

$("mt-download").addEventListener("click", async () => {
  const b = $("mt-download") as HTMLButtonElement;
  b.disabled = true;
  try {
    await MT.load((pct) => ($("mt-status").textContent = `Downloading... ${pct}%`));
    $("mt-status").textContent = "Checking...";
    const test = await MT.toEnglish("El gato duerme en la casa.");
    pref("mtReady", "1");
    mtStatus();
    $("mt-status").textContent += ` Test: "${test}"`;
  } catch (e) {
    $("mt-status").textContent = `Download failed: ${msg(e)}`;
  } finally {
    b.disabled = false;
  }
});

$("copy-bookmarklet").addEventListener("click", () => {
  const code = "javascript:" + bookmarkletSrc.replace(/^\s*\/\/.*$/gm, "").replace(/\s*\n\s*/g, " ").trim();
  navigator.clipboard.writeText(code).then(() => ($("copy-bookmarklet").textContent = "Copied"), (e) => ($("sync-detail").textContent = `Copy failed: ${msg(e)}`));
});
$("paste-login").addEventListener("click", async () => {
  try {
    const j = JSON.parse(await navigator.clipboard.readText());
    if (j?.lrReader !== 1 || !j.token) throw new Error("the clipboard does not hold a login from the bookmarklet");
    (settingsDlg.querySelector("[name=email]") as HTMLInputElement).value = j.email || "";
    (settingsDlg.querySelector("[name=token]") as HTMLInputElement).value = j.token;
    $("paste-login").textContent = "Pasted, now Save";
  } catch (e) {
    $("sync-detail").textContent = `Paste login: ${e instanceof SyntaxError ? "the clipboard does not hold a login from the bookmarklet" : msg(e)}`;
  }
});

$("test-voice").addEventListener("click", (e) => {
  e.preventDefault();
  const sel = settingsDlg.querySelector("[name=voice]") as HTMLSelectElement;
  const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === sel.value) || null;
  const rate = Number((settingsDlg.querySelector("[name=speechRate]") as HTMLSelectElement).value) || 1;
  speak("Hola, \u00bfqu\u00e9 tal? Me gusta mucho leer libros en espa\u00f1ol.", (m) => ($("sync-detail").textContent = m), voice, rate);
});

// ---- Library ----

async function showLibrary() {
  setTimeout(maybeUpdate);
  updateReviewCount();
  closeSheet();
  reader.hidden = true;
  lib.hidden = false;
  const list = await listBooks();
  books.innerHTML = list.length ? "" : `<li class="sub">No books yet. Import an EPUB.</li>`;
  $("backup-nudge").hidden = !list.length || Date.now() - Number(pref("lastBackup") || 0) < BACKUP_EVERY;
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
      await deleteBook(m.id, lang());
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
  $("prep-presets").onclick = (e) => {
    const n = Number((e.target as HTMLElement).dataset.n);
    if (Number.isNaN(n)) return;
    const from = Math.min(m.pos.ch, b.chapters.length - 1);
    prepFrom.value = String(from);
    prepTo.value = String(n ? Math.min(from + n - 1, b.chapters.length - 1) : b.chapters.length - 1);
    info();
  };
  info();
  prepDlg.onclose = () => {
    if (prepDlg.returnValue !== "go") return;
    const [a, z] = [Number(prepFrom.value), Number(prepTo.value)].sort((x, y) => x - y);
    startPrepare(id, Array.from({ length: z - a + 1 }, (_, i) => a + i), ($("prep-sum") as HTMLInputElement).checked);
  };
  prepDlg.showModal();
}

async function startPrepare(id: string, chapters: number[], withSummaries = false) {
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
    await prepareBook(b, chapters, source(), lang(), Number(settings().rate) || 4, job.ctl.signal, (p) => {
      job.text = prepText(p);
      if (job.line) job.line.textContent = job.text;
    }, async (ci) => {
      await chapterPrepared(id, ci, counts);
      if (!withSummaries) return;
      // A failed summary is reported but does not stop the translations of the next chapters.
      try {
        job.text += ` \u00b7 summarizing ${b.chapters[ci].title}...`;
        if (job.line) job.line.textContent = job.text;
        await summaryFor(b, ci, pref("sumLang") || settings().tl, defaultProvider());
      } catch (e) {
        say(`Summary of "${b.chapters[ci].title}" failed: ${msg(e)}`, true);
      }
    });
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
let words: HTMLElement[] = [];
// Sentences before each chapter, for whole-book progress and the sentence index sent to Language Reactor.
let offsets: number[] = [];
// Current chapter's sentences and their cached translations, by index within the chapter.
let sents: string[] = [];
let trs: (lr.Translated | undefined)[] = [];

const W = () => viewport.clientWidth;
const pages = () => Math.max(1, Math.round(viewport.scrollWidth / W()));
const pageOf = (el: Element) => Math.floor((el.getBoundingClientRect().left - content.getBoundingClientRect().left) / W());
const trKey = (text: string) => S.trKey(source(), text, lang());

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

// Dictionary forms of a sentence's words, worked out once per translation (mark() runs on every tap).
const lemmaCache = new WeakMap<lr.Translated, string[]>();
function sentenceLemmas(si: number, ws: HTMLElement[]): string[] {
  const tr = trs[si];
  const forms = () => ws.map((w) => w.textContent!.toLowerCase());
  if (!tr) return forms();
  let l = lemmaCache.get(tr);
  if (!l) lemmaCache.set(tr, (l = ws.map((w) => lemmaFor(w).lemma)));
  return l.length === ws.length ? l : forms();
}

function mark() {
  if (reader.hidden) return;
  const sl = settings().sl;
  spans.forEach((span, si) => {
    const ws = [...span.children] as HTMLElement[];
    const lemmas = sentenceLemmas(si, ws);
    ws.forEach((w, k) => w.classList.toggle("learning", stageOf(lemmas[k], w.textContent!.toLowerCase(), sl) === "LEARNING"));
  });
}

async function openBook(id: string) {
  clearReturn();
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

// Bumped whenever the book or chapter on screen changes; late async results for an older view are dropped.
let view = 0;
const goToSentence = (si: number) => goto(spans[si] ? pageOf(spans[si]) : 0);

function showChapter(i: number, sentence: number | "end" = 0) {
  closeSheet();
  if (!readingFromChapter(i)) stopReading();
  view++;
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
  words = [...content.querySelectorAll<HTMLElement>(".w")];
  content.lang = settings().sl;
  if (sentence === "end") goto(pages() - 1);
  else goToSentence(sentence);
  const shown = view;
  cacheGetMany<lr.Translated>(sents.map(trKey)).then((all) => {
    if (view !== shown) return;
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
  where.textContent = `${pageBookmark() ? "\u2605 " : ""}${book.chapters[ch].title} \u00b7 ${page + 1}/${pages()}${bookPage()} \u00b7 ${pct(meta.done, meta.sentences)}%`;
  const { id, pos, done } = meta;
  const bookmarks = meta.bookmarks;
  getMeta(id).then((m) => m && putMeta({ ...m, pos, done, bookmarks }));
  translatePage();
}

// Translate what is on screen and the next page, so lemmas highlight and taps answer from cache.
let translating = false;
let again = false;
let loaded = false;
// Sentences being translated right now, so a tap on one waits for that request instead of sending another.
const pendingTr = new Map<string, Promise<lr.Translated>>();
function translateBatch(texts: string[]): Promise<lr.Translated[]> {
  const p = S.translate(source(), texts, lang()).then(async (res) => {
    await Promise.all(res.map((r, k) => cacheSet(trKey(texts[k]), r)));
    return res;
  });
  texts.forEach((t, k) => {
    const one = p.then((r) => r[k]);
    // Whoever awaits it still sees a failure; this only stops an unawaited one being reported as unhandled.
    one.catch(() => {});
    pendingTr.set(t, one);
  });
  p.finally(() => texts.forEach((t) => pendingTr.delete(t))).catch(() => {});
  return p;
}

// AI sources take seconds per request, growing with the text, so the first sentences on screen go in a
// small request and the rest in parallel requests started at the same time. Language Reactor takes
// 500-character batches one after another.
const FIRST_CHARS = 200, PARALLEL_AI = 4;
async function translatePage() {
  if (translating) return void (again = true);
  if (!loaded || !navigator.onLine || !spans.length) return;
  const want: number[] = [];
  for (let i = Math.max(0, firstFrom(page) - 1); i < spans.length && pageOf(spans[i]) <= page + 1; i++) if (!trs[i] && !pendingTr.has(sents[i])) want.push(i);
  if (!want.length) return;
  translating = true;
  const shown = view, src = source();
  const batches: number[][] = [];
  let len = 0;
  for (const i of want) {
    const cap = src.ai && batches.length <= 1 ? FIRST_CHARS : src.batchChars;
    if (!batches.length || (len + sents[i].length + 1 > cap && batches[batches.length - 1].length)) batches.push([]), (len = 0);
    batches[batches.length - 1].push(i);
    len += sents[i].length + 1;
  }
  const run = async (batch: number[]) => {
    const res = await translateBatch(batch.map((i) => sents[i]));
    if (view !== shown) return;
    res.forEach((r, k) => (trs[batch[k]] = r));
    mark();
  };
  try {
    if (!src.ai) for (const b of batches) await run(b);
    else {
      let next = 0;
      await Promise.all(Array.from({ length: PARALLEL_AI }, async () => {
        while (next < batches.length) await run(batches[next++]);
      }));
    }
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

const translateCached = (text: string) => pendingTr.get(text) ?? cached(trKey(text), async () => (await translateBatch([text]))[0]);

async function ensureTr(si: number): Promise<lr.Translated> {
  if (trs[si]) return trs[si]!;
  const shown = view;
  const r = await translateCached(sents[si]);
  if (view === shown) trs[si] = r;
  return r;
}

function turn(dir: 1 | -1) {
  closeSheet();
  countPage();
  clearReturn();
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
  document.querySelectorAll<HTMLElement>(".panel").forEach((p) => (p.hidden = true));
  current?.classList.remove("on");
  current = null;
  selected.forEach((x) => x.classList.remove("sel"));
  selected = [];
}

async function openWord(w: HTMLElement) {
  closeSheet();
  current = w;
  w.classList.add("on");
  const form = w.textContent!;
  const si = Number((w.parentElement as HTMLElement).dataset.s);
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
    entries = await cached(hdKey(form, t, lang()), () => S.gloss(source(), form, t, sents[si], lang()));
  } catch (e) {
    const byLemma = token && (await cacheGet<string[]>(hdLemmaKey(token, lang())));
    if (byLemma) entries = byLemma;
    else err ||= `Dictionary: ${msg(e)}`;
  }
  if (current !== w) return;
  currentGlosses = entries;
  let enSent = "", offlineNote = "";
  if (mtOn() && (!tr || !entries.length)) {
    try {
      const [ew, es] = await Promise.all([entries.length ? "" : offlineEn(form), tr ? "" : offlineEn(sents[si])]);
      if (ew) entries = [ew];
      enSent = es;
      offlineNote = "Offline: English from the on-device model.";
      err = "";
    } catch (e) {
      err ||= `Offline translation: ${msg(e)}`;
    }
    if (current !== w) return;
  }
  const stage = stageOf(lemma);
  const btn = (s: string, label: string) => `<button data-stage="${s}" class="${stage === s ? "on" : ""}">${label}</button>`;
  sheet.innerHTML = `<h3>${esc(form)}</h3>
    ${lemma !== form.toLowerCase() || token?.pos ? `<div class="lemma">${lemma !== form.toLowerCase() ? esc(lemma) + " &middot; " : ""}${esc((token?.pos || "").toLowerCase())}</div>` : ""}
    <div class="tr">${entries.length ? entries.map(esc).join(", ") : err ? "" : "no translation"}</div>
    <div class="sent">${esc(sents[si])}<b>${tr ? esc(tr.tr) : esc(enSent)}</b></div>
    <div class="sub" id="word-extra"></div>
    ${err ? `<div class="err">${esc(err)}</div>` : ""}
    ${offlineNote ? `<div class="sub">${offlineNote}</div>` : ""}
    <div class="act">${btn("LEARNING", "Learning")}${btn("KNOWN", "Known")}<button data-act="say">Play</button><button data-act="say-sentence">Play sentence</button><button data-act="more">More</button><button data-act="examples">Show examples</button></div>
    <div id="more"></div>
    <div id="examples"></div>`;
  wordExtras(w, form, lemma, token?.pos || "", sents[si]);
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
  const form = w.textContent!.toLowerCase();
  const { sl, email } = settings();
  const key = lr.wordKey(lemma, sl);
  const next = stageOf(lemma, form) === stage ? undefined : stage;
  // An offline draft for this word, keyed by its written form, is replaced by whatever happens now.
  if (form !== lemma) outbox = drop(outbox, lr.wordKey(form, sl));
  if (!next) {
    outbox = lemma in synced || sending.has(key) ? enqueue(outbox, "remove", key, email) : drop(outbox, key);
  } else {
    const tr = trs[si];
    const draft: Draft = { draft: true, itemType: "WORD", learningStage: next, offset: Number(w.dataset.o), ...where0(si) };
    outbox = enqueue(outbox, "save", key, email, tr && index >= 0 ? lr.wordItem(lemma, next, index, { ...draft, tr: tr.tr, nlp: tr.nlp }, lang()) : draft);
  }
  cacheSet("outbox", outbox);
  logWord(si, lemma, form, Number(w.dataset.o), next);
  sheet.querySelectorAll<HTMLElement>("[data-stage]").forEach((b) => b.classList.toggle("on", b.dataset.stage === next));
  mark();
  renderSync();
  flushOutbox();
}

// ---- Examples and search: sentences from the whole book ----

type Found = { ci: number; si: number; text: string };
let bookSents: (Found & { folded?: string })[] = [];
const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])(${words.map(reEsc).join("|")})(?![\\p{L}\\p{M}\\p{N}])`, "giu");

// A jump from an example, a search result or a bookmark leaves a way back to the sentence being read,
// until the reader turns a page or picks a chapter, which means carrying on from the new place.
let returnTo: { ch: number; s: number } | null = null;
function clearReturn() {
  returnTo = null;
  $("return").hidden = true;
}
function show(ci: number, si: number) {
  if (ci === ch) goToSentence(si);
  else showChapter(ci, si);
}
function jumpTo(ci: number, si: number) {
  closeSheet();
  $("search-panel").hidden = true;
  returnTo ||= { ch, s: meta.pos.s };
  $("return").hidden = false;
  show(ci, si);
  const el = spans[si];
  el?.classList.add("flash");
  setTimeout(() => el?.classList.remove("flash"), 2500);
}

function foundList(hits: (Found & { tr?: string })[], mark: (text: string) => string) {
  return hits
    .map((h) => `<button class="found" data-ci="${h.ci}" data-si="${h.si}"><span>${mark(h.text)}</span>${h.tr ? `<i>${esc(h.tr)}</i>` : ""}<small>${esc(book.chapters[h.ci].title)}</small></button>`)
    .join("");
}

$("return").addEventListener("click", () => {
  const back = returnTo;
  clearReturn();
  if (back) show(back.ch, back.s);
});

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
    const res = await S.translate(source(), missing.map((h) => h.text), lang());
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
    const hits = bookSents.filter((x) => (x.folded ??= fold(x.text)).includes(q));
    const mark = (t: string) => {
      const f = fold(t), i = f.indexOf(q);
      return f.length === t.length && i >= 0 ? esc(t.slice(0, i)) + `<b>${esc(t.slice(i, i + q.length))}</b>` + esc(t.slice(i + q.length)) : esc(t);
    };
    box.innerHTML = `<div class="sub">${hits.length} sentence${hits.length === 1 ? "" : "s"}${hits.length > 100 ? ", first 100 shown" : ""}</div>` + foundList(hits.slice(0, 100), mark);
  }, 250);
});

// ---- Bookmarks ----

const bookmarksPanel = $("bookmarks-panel");
// A bookmark belongs to the page its sentence starts on (or, on a page where no sentence starts, the one
// running through it).
function pageBookmark(): Bookmark | undefined {
  const f = firstFrom(page), next = firstFrom(page + 1);
  return (meta.bookmarks || []).find((b) => b.ch === ch && ((b.s >= f && b.s < next) || (f === next && b.s === f - 1)));
}
function renderBookmarks() {
  const here = pageBookmark();
  $("bookmark-toggle").textContent = here ? "Remove bookmark here" : "Bookmark this page";
  const list = [...(meta.bookmarks || [])].sort((a, b) => a.ch - b.ch || a.s - b.s);
  $("bookmark-list").innerHTML = list.length
    ? foundList(list.map((b) => ({ ci: b.ch, si: b.s, text: b.text, tr: new Date(b.at).toLocaleDateString() })), esc)
    : `<div class="sub">No bookmarks yet.</div>`;
}
$("bookmarks").addEventListener("click", () => {
  const open = bookmarksPanel.hidden;
  closeSheet();
  if (!open) return;
  renderBookmarks();
  bookmarksPanel.hidden = false;
});
$("bookmark-toggle").addEventListener("click", () => {
  const here = pageBookmark();
  const s = anchor();
  let text = "";
  for (let i = s; i < sents.length && text.length < 80; i++) text += (text ? " " : "") + sents[i];
  const next = here ? (meta.bookmarks || []).filter((b) => b !== here) : [...(meta.bookmarks || []), { ch, s, text: text.slice(0, 140), at: Date.now() }];
  meta.bookmarks = next;
  goto(page);
  renderBookmarks();
});

// ---- Summaries ----

const summaryPanel = $("summary-panel"), summaryOut = $("summary-out"), sumLang = $<HTMLSelectElement>("sum-lang");
$("summary").addEventListener("click", () => {
  const open = summaryPanel.hidden;
  closeSheet();
  if (!open) return;
  const { sl, tl } = settings();
  const name = (c: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(c) || c;
  sumLang.innerHTML = `<option value="${tl}">In ${esc(name(tl))}</option><option value="${sl}">In easy ${esc(name(sl))}</option>`;
  sumLang.value = pref("sumLang") || tl;
  showSaved();
  const st = settings();
  const both = !st.claudeKey && !st.openaiKey;
  $("sum-claude").textContent = `Summarize with ${Sum.CLAUDE_MODELS[st.claudeModel] || "Claude"}`;
  $("sum-openai").textContent = `Summarize with ${Sum.OPENAI_MODELS[st.openaiModel] || "ChatGPT"}`;
  $("sum-claude").hidden = !both && !st.claudeKey;
  $("sum-openai").hidden = !both && !st.openaiKey;
  summaryPanel.hidden = false;
});
sumLang.addEventListener("change", () => {
  pref("sumLang", sumLang.value);
  showSaved();
});

const modelName = (m: string) => Sum.CLAUDE_MODELS[m] || Sum.OPENAI_MODELS[m] || m;
type Saved = { text: string; model: string; at: number };
// The latest summary of a text in a language, from whichever model made it; shown as soon as the panel opens.
const savedKey = (outLang: string, text: string) => `sumlast|${outLang}|${lr.md5(text)}`;
const renderSummary = (v: Saved) => {
  summaryOut.innerHTML = `<div class="sub">${esc(modelName(v.model))} \u00b7 ${new Date(v.at).toLocaleString()}</div><div></div>`;
  summaryOut.lastElementChild!.textContent = v.text;
};
async function showSaved() {
  const run = ++sumRun;
  const v = await cacheGet<Saved>(savedKey(sumLang.value, sumScope === "page" ? pageText() : chapterText()));
  if (run !== sumRun) return;
  if (v) renderSummary(v);
  else summaryOut.textContent = "";
}

function pageText(): string {
  const out: string[] = [];
  for (let i = Math.max(0, firstFrom(page) - 1); i < spans.length && pageOf(spans[i]) <= page; i++) out.push(sents[i]);
  return out.join(" ");
}
type Provider = "claude" | "openai";
// Prepare uses the provider last used in the panel, else the one with a key.
const defaultProvider = (): Provider => (pref("sumProvider") as Provider) || (settings().claudeKey ? "claude" : "openai");
const textOf = (bk: Book, ci: number) => bk.chapters[ci].blocks.map((b) => b.sentences.join(" ")).join("\n\n");
const chapterText = () => textOf(book, ch);

// Cached per model, language and exact text, so the panel finds summaries made while preparing.
async function summaryFor(bk: Book, ci: number, outLang: string, provider: Provider, text = textOf(bk, ci), scope: "page" | "chapter" = "chapter", onText = (_: string) => {}): Promise<string> {
  const s = settings();
  const openai = provider === "openai";
  const key = openai ? s.openaiKey : s.claudeKey;
  const model = openai ? s.openaiModel : s.claudeModel;
  const cacheKey = `sum|${model}|${outLang}|${lr.md5(text)}`;
  const hit = await cacheGet<string>(cacheKey);
  if (hit) {
    if (!(await cacheGet(savedKey(outLang, text)))) await cacheSet(savedKey(outLang, text), { text: hit, model, at: Date.now() } satisfies Saved);
    return hit;
  }
  if (!key) throw new Error(`add a ${openai ? "OpenAI" : "Claude"} API key in Settings, or use Open in Claude / Open in ChatGPT`);
  if (!navigator.onLine) throw new Error("summaries need a connection the first time; ones made before open offline");
  const ask: Sum.Ask = { text, scope, title: bk.chapters[ci].title, sl: s.sl, tl: s.tl, outLang };
  const out = openai ? await Sum.openaiSummarize(ask, key, model, onText) : await (await import("./ai")).summarize(ask, key, model, onText);
  await Promise.all([cacheSet(cacheKey, out), cacheSet(savedKey(outLang, text), { text: out, model, at: Date.now() } satisfies Saved)]);
  return out;
}

let sumScope: "page" | "chapter" = "page";
let sumRun = 0;

summaryPanel.addEventListener("click", async (e) => {
  const scopeBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-scope]");
  if (scopeBtn) {
    sumScope = scopeBtn.dataset.scope as "page" | "chapter";
    summaryPanel.querySelectorAll<HTMLElement>("[data-scope]").forEach((x) => x.classList.toggle("on", x === scopeBtn));
    return void showSaved();
  }
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sum]");
  if (!b) return;
  const run = ++sumRun;
  const s = settings();
  const ask: Sum.Ask = { text: sumScope === "page" ? pageText() : chapterText(), scope: sumScope, title: book.chapters[ch].title, sl: s.sl, tl: s.tl, outLang: sumLang.value };
  const how = b.dataset.sum!;
  if (!how.startsWith("key-")) {
    // Key-free path: hand the request to the Claude or ChatGPT app; also copied in case it is too long for a link.
    const text = Sum.chatText(ask);
    navigator.clipboard?.writeText(text).catch(() => {});
    if (how === "share") return void navigator.share?.({ text }).catch(() => {});
    window.open(Sum.chatUrl(how as "claude" | "chatgpt", text), "_blank");
    summaryOut.innerHTML = Sum.fitsUrl(text) ? `<div class="sub">Opened with the text filled in (also copied).</div>` : `<div class="sub">Too long for a link: the request is copied, paste it into the chat.</div>`;
    return;
  }
  const provider: Provider = how === "key-openai" ? "openai" : "claude";
  const model = provider === "openai" ? s.openaiModel : s.claudeModel;
  // Models think before the first word arrives; show that something is happening until it does.
  const started = Date.now();
  const waiting = () => `Summarizing this ${ask.scope} with ${modelName(model)}... ${Math.round((Date.now() - started) / 1000)}s`;
  summaryOut.innerHTML = `<div class="sub"></div><div></div>`;
  const status = summaryOut.firstElementChild!, body = summaryOut.lastElementChild!;
  status.textContent = waiting();
  const timer = setInterval(() => run === sumRun && !body.textContent && (status.textContent = waiting()), 1000);
  // A summary still streaming must not write over a newer one.
  const onText = (t: string) => {
    if (run !== sumRun) return;
    if (!body.textContent) status.textContent = `${modelName(model)} \u00b7 writing...`;
    body.textContent += t;
  };
  try {
    pref("sumProvider", provider);
    const out = await summaryFor(book, ch, sumLang.value, provider, ask.text, ask.scope, onText);
    if (run === sumRun) renderSummary({ text: out, model, at: Date.now() });
  } catch (err) {
    if (run === sumRun) summaryOut.innerHTML = `<div class="err">${esc(msg(err))}</div>`;
  } finally {
    clearInterval(timer);
  }
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
    const src = source();
    const si = Number((w.parentElement as HTMLElement).dataset.s);
    const entries = await cached(`fd|${src.id}|${s.sl}|${s.tl}|${form.toLowerCase()}|${token?.lemma?.text || ""}|${token?.pos || ""}`, () => S.dictionary(src, form, token, sents[si], lang()));
    box.innerHTML = entries
      .map((e) => `<div class="pos">${esc(e.word)}</div>` + e.posGroups.filter((g) => g.translations.length).map((g) => `<div><i>${esc((g.pos || "other").toLowerCase())}</i> ${g.translations.map(esc).join(", ")}</div>`).join(""))
      .join("") || "no entry";
  } catch (e) {
    box.innerHTML = `<div class="err">${esc(msg(e))}</div>`;
  }
}

// Popularity from the bundled frequency list, and synonyms from ChatGPT/Claude when a key is set.
function aiForExtras(): import("./aitr").AiCfg | null {
  const s = settings(), src = source();
  if (src.ai) return src.ai;
  if (s.openaiKey) return { provider: "openai", key: s.openaiKey, model: s.trModelOpenai };
  if (s.claudeKey) return { provider: "claude", key: s.claudeKey, model: s.trModelClaude };
  return null;
}
async function wordExtras(w: HTMLElement, form: string, lemma: string, pos: string, sentence: string) {
  const box = () => (current === w ? document.getElementById("word-extra") : null);
  const parts: string[] = [];
  const render = () => box() && (box()!.textContent = parts.filter(Boolean).join(" \u00b7 "));
  const sl = settings().sl;
  if (Freq.supported(sl)) {
    Freq.popularity(form, lemma).then((p) => ((parts[0] = `Frequency ${p}`), render())).catch(() => {});
  }
  const cfg = aiForExtras();
  if (!cfg) return;
  try {
    const syn = await cached(`syn|${sl}|${lemma}|${pos}`, () => aiSynonyms(lemma, pos, sentence, lang(), cfg));
    parts[1] = syn.length ? `Synonyms: ${syn.join(", ")}` : "";
    render();
  } catch {}
}

const mtOn = () => pref("mtReady") === "1" && MT.supported(settings().sl);
const offlineEn = (text: string) => cached(`mt|es-en|${text}`, () => MT.toEnglish(text));

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
  const [a, b] = [words.indexOf(from), words.indexOf(to)].sort((x, y) => x - y);
  const next = words.slice(a, b + 1);
  const keep = new Set(next);
  selected.forEach((x) => keep.has(x) || x.classList.remove("sel"));
  next.forEach((x) => x.classList.add("sel"));
  selected = next;
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
    tr = await translateCached(text);
    await ensureTr(si);
  } catch (e) {
    err = `${msg(e)}. Save phrase still works; it is sent when you are back online.`;
  }
  if (selected !== sel) return;
  let enPhrase = "", enSent = "";
  if (!tr && mtOn()) {
    try {
      [enPhrase, enSent] = await Promise.all([offlineEn(text), trs[si] ? "" : offlineEn(sents[si])]);
      err = "Offline: English from the on-device model. Save phrase still works; it is sent when you are back online.";
    } catch {}
    if (selected !== sel) return;
  }
  phrase = { text, tr: tr?.tr || "", nlp: tr?.nlp || [], si };
  const key = lr.phraseKey(text, sl);
  const queued = outbox.some((x) => x.key === key);
  sheet.innerHTML = `<h3>${esc(text)}</h3>
    <div class="tr">${tr ? esc(tr.tr) : esc(enPhrase)}</div>
    ${trs[si] || enSent ? `<div class="sent">${esc(sents[si])}<b>${esc(trs[si]?.tr || enSent)}</b></div>` : ""}
    ${err ? `<div class="${enPhrase ? "sub" : "err"}">${esc(err)}</div>` : ""}
    <div class="act"><button data-act="save-phrase" class="${queued ? "on" : ""}">${queued ? "Saved" : "Save phrase"}</button><button data-act="say">Play</button><button data-act="say-sentence">Play sentence</button></div>`;
}

function savePhrase(b: HTMLElement) {
  if (!phrase) return;
  const tr = trs[phrase.si];
  const draft: Draft = { draft: true, itemType: "PHRASE", learningStage: "LEARNING", phrase: phrase.text, ...where0(phrase.si) };
  const item = tr && phrase.nlp.length ? lr.phraseItem(phrase.text, phrase.tr, phrase.nlp, { ...draft, tr: tr.tr, nlp: tr.nlp }, lang()) : draft;
  outbox = enqueue(outbox, "save", lr.phraseKey(phrase.text, settings().sl), settings().email, item);
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

// ---- Word log, review, read aloud, stats, density, backup ----

let currentGlosses: string[] = [];
const logKey = (bookId: string) => `wl|${bookId}`;

// Every word marked in the reader is kept with its sentence, for the word list and for review.
async function logWord(si: number, lemma: string, form: string, offset: number, stage?: lr.Stage) {
  const log = (await cacheGet<Record<string, Study.WordEntry>>(logKey(meta.id))) || {};
  if (!stage) delete log[lemma];
  else {
    const now = Date.now();
    log[lemma] = { box: 0, due: now, at: now, ...(log[lemma] as Study.WordEntry | undefined), lemma, form, stage, bookId: meta.id, bookTitle: meta.title, ch, si, offset, ...where0(si), tr: trs[si]?.tr || "", glosses: currentGlosses };
    bumpStat({ marked: 1 });
  }
  await cacheSet(logKey(meta.id), log);
}

const allWords = async () => (await getCacheByPrefix<Record<string, Study.WordEntry>>("wl|")).flatMap(([, v]) => Object.values(v || {}));
async function saveEntry(e: Study.WordEntry) {
  const log = (await cacheGet<Record<string, Study.WordEntry>>(logKey(e.bookId))) || {};
  log[e.lemma] = e;
  await cacheSet(logKey(e.bookId), log);
}

// Reading time counts the gap between page turns when it is under two minutes.
let lastActive = 0;
async function bumpStat(add: Partial<Study.Day>) {
  const k = `stats|${Study.dayKey()}`;
  const d = (await cacheGet<Study.Day>(k)) || { ms: 0, pages: 0, marked: 0 };
  await cacheSet(k, { ms: d.ms + (add.ms || 0), pages: d.pages + (add.pages || 0), marked: d.marked + (add.marked || 0) });
}
function countPage() {
  const now = Date.now(), gap = now - lastActive;
  lastActive = now;
  bumpStat({ pages: 1, ms: gap < 120000 ? gap : 0 });
}

const menuPanel = $("menu-panel"), menuOut = $("menu-out");
$("menu").addEventListener("click", () => {
  const open = menuPanel.hidden;
  closeSheet();
  if (!open) return;
  menuOut.innerHTML = "";
  menuPanel.hidden = false;
});
menuPanel.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-menu]");
  if (!b) return;
  const what = b.dataset.menu;
  if (what === "words") showWords();
  if (what === "stats") showStats();
  if (what === "read") readAloud();
  if (what === "review") openReview(meta.id);
});

async function showWords() {
  const list = Object.values((await cacheGet<Record<string, Study.WordEntry>>(logKey(meta.id))) || {}).sort((a, b) => a.ch - b.ch || a.si - b.si);
  if (!list.length) return void (menuOut.innerHTML = `<div class="sub">No words marked in this book yet. Tap a word and choose Learning or Known.</div>`);
  menuOut.innerHTML =
    `<div class="sub">${list.length} word${list.length === 1 ? "" : "s"} marked in this book. Tap one to go to its sentence.</div>` +
    foundList(
      list.map((w) => ({ ci: w.ch, si: w.si, text: w.text, tr: `${w.form !== w.lemma ? `${w.form} \u2192 ` : ""}${w.lemma} \u00b7 ${w.glosses.slice(0, 3).join(", ")} \u00b7 ${w.stage.toLowerCase()}` })),
      esc,
    );
}

async function showStats() {
  const days = Study.lastDays(7);
  const vals = await Promise.all(days.map((d) => cacheGet<Study.Day>(`stats|${d}`)));
  const rows = days.map((d, i) => `<tr><td>${d}</td><td>${Math.round((vals[i]?.ms || 0) / 60000)} min</td><td>${vals[i]?.pages || 0}</td><td>${vals[i]?.marked || 0}</td></tr>`).join("");
  const sl = settings().sl;
  const lemmasOf = (from: number, to: number) => spans.slice(from, to).flatMap((span, k) => sentenceLemmas(from + k, [...span.children] as HTMLElement[]));
  const onPage = Study.density(lemmasOf(Math.max(0, firstFrom(page) - 1), firstFrom(page + 1)), (l) => stageOf(l, l, sl));
  const inChapter = Study.density(lemmasOf(0, spans.length), (l) => stageOf(l, l, sl));
  const words = await allWords();
  menuOut.innerHTML = `<table><tr><th>Day</th><th>Reading</th><th>Pages</th><th>Words marked</th></tr>${rows}</table>
    <p><b>Unknown words</b> (in neither your Known nor Learning list): this page ${onPage.pct}% (${onPage.unknown} of ${onPage.distinct}),
    this chapter ${inChapter.pct}% (${inChapter.unknown} of ${inChapter.distinct}). Words in sentences not translated yet count as written.</p>
    <p class="sub">This book: read ${pct(meta.done, meta.sentences)}%. Words marked in this app: ${words.length}, ${Study.due(words).length} due for review.</p>`;
}

// ---- Read aloud: the rest of the chapter, sentence by sentence, turning pages as it goes ----

let readingCh = -1;
const readingFromChapter = (i: number) => readingCh === i;
function stopReading() {
  if (readingCh < 0) return;
  readingCh = -1;
  speechSynthesis.cancel();
  $("reading-stop").hidden = true;
  content.querySelectorAll(".s.reading").forEach((x) => x.classList.remove("reading"));
}
function readAloud() {
  const voice = systemVoice() || deviceVoice();
  if (!voice) return void (menuOut.innerHTML = `<div class="err">This device has no voice for the book language.</div>`);
  closeSheet();
  stopReading();
  readingCh = ch;
  $("reading-stop").hidden = false;
  // Queued at once from the tap: iOS only lets speech start from a user action.
  for (let i = anchor(); i < sents.length; i++) {
    const u = new SpeechSynthesisUtterance(sents[i]);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = Number(settings().speechRate) || 1;
    u.onstart = () => {
      if (readingCh !== ch) return;
      content.querySelectorAll(".s.reading").forEach((x) => x.classList.remove("reading"));
      spans[i]?.classList.add("reading");
      const p = spans[i] ? pageOf(spans[i]) : page;
      if (p !== page) goto(p);
    };
    if (i === sents.length - 1) u.onend = stopReading;
    speechSynthesis.speak(u);
  }
}
$("reading-stop").addEventListener("click", stopReading);

// ---- Review ----

const reviewEl = $("review"), card = $("review-card");
let queue: Study.WordEntry[] = [];
async function openReview(bookId?: string) {
  closeSheet();
  const words = await allWords();
  queue = Study.due(bookId ? words.filter((w) => w.bookId === bookId) : words);
  reviewEl.hidden = false;
  showCard();
}
function showCard(answer = false) {
  $("review-left").textContent = queue.length ? `${queue.length} left` : "";
  const e = queue[0];
  if (!e) return void (card.innerHTML = `<h2>All done</h2><p class="sub">No words are due. Words you mark as Learning while reading come here.</p>`);
  const ctx = esc(e.text).replace(new RegExp(`(?<![\\p{L}])(${esc(e.form).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\p{L}])`, "iu"), "<b>$1</b>");
  card.innerHTML = `<h2>${esc(e.form)}</h2><div class="ctx">${ctx}</div><div class="sub">${esc(e.bookTitle)}</div>
    <div class="act"><button data-r="say">Play</button><button data-r="say-sentence">Play sentence</button></div>
    ${answer
      ? `<div class="answer"><div><b>${esc(e.lemma)}</b> \u00b7 ${esc(e.glosses.join(", ") || "-")}</div><div class="sub">${esc(e.tr)}</div></div>
         <div class="grades"><button data-r="again">Again</button><button data-r="good">Good</button><button data-r="known">Known</button></div>`
      : `<div class="grades"><button data-r="show">Show answer</button></div>`}`;
}
card.addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-r]");
  const e = queue[0];
  if (!b || !e) return;
  const r = b.dataset.r;
  const err = (m: string) => card.insertAdjacentHTML("beforeend", `<div class="err">${esc(m)}</div>`);
  if (r === "say") return speak(e.form, err);
  if (r === "say-sentence") return speak(e.text, err);
  if (r === "show") return showCard(true);
  queue.shift();
  if (r === "known") {
    // Marked KNOWN on Language Reactor too, completed at sync time like an offline mark.
    const { sl, email } = settings();
    const draft: Draft = { draft: true, itemType: "WORD", learningStage: "KNOWN", offset: e.offset, text: e.text, prev: e.prev, next: e.next, ref: e.ref };
    outbox = enqueue(outbox, "save", lr.wordKey(e.lemma, sl), email, draft);
    cacheSet("outbox", outbox);
    flushOutbox();
    await saveEntry({ ...e, stage: "KNOWN" });
  } else {
    const g = Study.grade(e, r === "good");
    await saveEntry(g);
    if (r === "again") queue.push(g);
  }
  showCard();
});
async function updateReviewCount() {
  const n = Study.due(await allWords()).length;
  $("open-review").textContent = n ? `Review (${n})` : "Review";
}
$("open-review").addEventListener("click", () => openReview());
$("review-close").addEventListener("click", () => {
  reviewEl.hidden = true;
  if (!lib.hidden) showLibrary();
});

// ---- Backup ----

const SECRET = ["token", "claudeKey", "openaiKey"];
const BACKUP_EVERY = 7 * 864e5;
let backupFile: File | null = null;
let leftOut = "";
$("backup-export").addEventListener("click", () => exportBackup($("backup-status")));
$("backup-nudge").addEventListener("click", () => exportBackup($("backup-nudge")));
async function exportBackup(status: HTMLElement) {
  try {
    const file = backupFile || (await buildBackup(status));
    // iOS saves files through the share sheet ("Save to Files" > iCloud Drive); elsewhere a download works.
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (e) {
        // Safari drops the tap's permission while a big backup is built; the next tap shares it at once.
        if ((e as Error).name !== "NotAllowedError") return void (backupFile = null);
        backupFile = file;
        return void (status.textContent = "Backup ready. Tap again to save it.");
      }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    backupFile = null;
    pref("lastBackup", String(Date.now()));
    status.textContent = `Saved backup (${(file.size / 1e6).toFixed(1)} MB).${leftOut}`;
    $("backup-nudge").hidden = true;
  } catch (e) {
    backupFile = null;
    status.textContent = `Backup failed: ${msg(e)}`;
  }
}
async function buildBackup(status: HTMLElement) {
  status.textContent = "Preparing...";
  const metas = await listBooks();
  // A book the browser can no longer read is left out and named, instead of failing the whole export.
  const unreadable: string[] = [];
  const books = (await Promise.all(metas.map(async (m) => ({ meta: m, book: await getBook(m.id).catch(() => void unreadable.push(m.title)) })))).filter((b) => b.book);
  leftOut = unreadable.length ? ` Could not read: ${unreadable.join(", ")}.` : "";
  const cacheEntries = (await Promise.all(["wl|", "sum|", "sumlast|", "stats|", "keys|", "outbox"].map((p) => getCacheByPrefix(p)))).flat();
  const s: Record<string, unknown> = { ...settings() };
  if (!($("backup-secrets") as HTMLInputElement).checked) for (const k of SECRET) delete s[k];
  const data = { app: "lr-reader", version: 1, exportedAt: new Date().toISOString(), settings: s, look: pref("look"), books, cache: cacheEntries };
  // One fixed name, so saving to the same iCloud folder replaces the previous backup.
  return new File([JSON.stringify(data)], "lr-reader-backup.json", { type: "application/json" });
}
$("backup-import").addEventListener("change", async () => {
  const input = $("backup-import") as HTMLInputElement, status = $("backup-status");
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data?.app !== "lr-reader") throw new Error("not an LR Reader backup");
    // Translations are not in the backup, so nothing counts as prepared after a restore.
    for (const { meta: m, book: b } of data.books) if (b) await putBook({ ...m, prepared: 0, preparedChapters: [] }, b);
    await setCacheMany(data.cache);
    const keep = Object.fromEntries(SECRET.map((k) => [k, (settings() as Record<string, unknown>)[k]]));
    pref("settings", JSON.stringify({ ...keep, ...data.settings }));
    if (data.look) pref("look", data.look);
    outboxLoaded = false;
    status.textContent = `Restored ${data.books.length} books and ${data.cache.length} other records.`;
    loadWords();
    showLibrary();
  } catch (e) {
    status.textContent = `Import failed: ${msg(e)}`;
  }
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
  if (!sheet.hidden || document.querySelector(".panel:not([hidden])")) return closeSheet();
  const x = e.clientX / W();
  if (x < 0.3) turn(-1);
  else if (x > 0.7) turn(1);
});

// Swipe a sheet or panel down to close it. Touch events, because iOS cancels pointer events once it scrolls.
let pull: { el: HTMLElement; y: number; dy: number } | null = null;
document.addEventListener("touchstart", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("#sheet, .panel");
  pull = el && el.scrollTop <= 0 ? { el, y: e.touches[0].clientY, dy: 0 } : null;
  if (pull) pull.el.style.transition = "";
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (!pull) return;
  pull.dy = e.touches[0].clientY - pull.y;
  pull.el.style.transform = pull.dy > 0 && pull.el.scrollTop <= 0 ? `translateY(${pull.dy}px)` : "";
}, { passive: true });
const endPull = () => {
  if (!pull) return;
  const { el, dy } = pull;
  pull = null;
  el.style.transition = "transform 0.2s";
  el.style.transform = "";
  if (dy > 80 && el.scrollTop <= 0) closeSheet();
};
document.addEventListener("touchend", endPull);
document.addEventListener("touchcancel", endPull);

document.addEventListener("keydown", (e) => {
  if (reader.hidden || settingsDlg.open) return;
  if (e.key === "ArrowRight" || e.key === " ") turn(1);
  if (e.key === "ArrowLeft") turn(-1);
  if (e.key === "Escape") closeSheet();
});
addEventListener("resize", relayout);

toc.addEventListener("change", () => {
  clearReturn();
  showChapter(Number(toc.value));
});
$("back").addEventListener("click", () => {
  stopReading();
  showLibrary();
});

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

// A new version is applied at a safe moment: right after launch, on the library with nothing open, or
// when the app goes to the background; never while a dialog or panel is in use.
const started = Date.now();
let applyUpdate: (() => void) | null = null;
const busy = () => !!document.querySelector("dialog[open]") || !sheet.hidden || !!document.querySelector(".panel:not([hidden])");
const maybeUpdate = () => applyUpdate && (Date.now() - started < 5000 || (!lib.hidden && !busy()) || document.visibilityState === "hidden") && applyUpdate();
// The new worker takes over by itself (skipWaiting); the page keeps running the old code until it
// reloads here. A change of controller on a page that already had one is an update.
if ("serviceWorker" in navigator) {
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadWorker) return;
    applyUpdate = () => location.reload();
    maybeUpdate();
  });
  navigator.serviceWorker.register("./sw.js");
}
document.addEventListener("visibilitychange", maybeUpdate);
navigator.storage?.persist?.();
showLibrary();
loadWords();
