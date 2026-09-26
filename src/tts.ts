// Device voices. In the iOS app the WebView's speechSynthesis sees only the built-in voices, so the
// native plugin speaks instead: it also sees the Enhanced and Premium voices downloaded in iOS Settings.
import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

export type Voice = { voiceURI: string; name: string; lang: string; default: boolean };
type Events = { onstart?: () => void; onend?: () => void };

const native = Capacitor.isNativePlatform();
let nativeVoices: Voice[] = [];
let changed = () => {};
let queue: { text: string; voice: Voice; rate: number; ev: Events }[] = [];
let busy = false;
// stop() bumps this; an utterance cancelled by it (iOS resolves speak() on cancel) must not fire onend.
let gen = 0;

export const voices = (): Voice[] => (native ? nativeVoices : speechSynthesis.getVoices());

export function onVoicesChanged(cb: () => void) {
  changed = cb;
  // iOS lists no voices until they load, and its speechSynthesis supports only the on* handler.
  if (!native) speechSynthesis.onvoiceschanged = cb;
}
if (native) TextToSpeech.getSupportedVoices().then((r) => ((nativeVoices = r.voices), changed()));
else speechSynthesis.getVoices();

// Queued after anything already speaking; stop() clears the queue.
export function say(text: string, voice: Voice, rate: number, ev: Events = {}) {
  if (!native) {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice as SpeechSynthesisVoice;
    u.lang = voice.lang;
    u.rate = rate;
    u.onstart = () => ev.onstart?.();
    u.onend = () => ev.onend?.();
    return speechSynthesis.speak(u);
  }
  queue.push({ text, voice, rate, ev });
  if (!busy) next();
}
async function next() {
  const u = queue.shift();
  busy = !!u;
  if (!u) return;
  u.ev.onstart?.();
  const g = gen;
  await TextToSpeech.speak({ text: u.text, lang: u.voice.lang, rate: u.rate, voice: nativeVoices.indexOf(u.voice), queueStrategy: 0 }).catch(() => {});
  if (g === gen) u.ev.onend?.();
  next();
}

export function stop() {
  if (!native) return speechSynthesis.cancel();
  queue = [];
  gen++;
  TextToSpeech.stop().catch(() => {});
}
