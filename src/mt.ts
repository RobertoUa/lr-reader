// Offline Spanish->English translation with a small model run in the browser (in a Web Worker), for
// sentences that were not prepared. There is no good es->uk model that runs here (the one tried answered
// in Russian). The onnxruntime files are served from this app: by default transformers.js imports them
// from a CDN, which would run third-party code next to the API keys, and would not be cached offline.
import ortAsyncMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortAsyncWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

export const supported = (sl: string) => sl === "es";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onProgress?: (pct: number) => void };
const pending = new Map<number, Pending>();
let worker: Worker | null = null, seq = 0;

function call(msg: object, onProgress?: (pct: number) => void): Promise<any> {
  if (!worker) {
    worker = new Worker(new URL("./mt.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, progress, done, text, error } = e.data, p = pending.get(id);
      if (!p) return;
      if (progress !== undefined) return p.onProgress?.(progress);
      pending.delete(id);
      if (error) p.reject(new Error(error));
      else if (done) p.resolve(text);
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker!.postMessage({ ...msg, id });
  });
}

let loading: Promise<void> | null = null;
export function load(onProgress?: (pct: number) => void): Promise<void> {
  // Same choice transformers.js makes: Safari before 26 without WebGPU needs the non-asyncify build.
  const oldSafari = Number(/Version\/(\d+).*Safari/.exec(navigator.userAgent)?.[1] ?? 99) < 26 && !("gpu" in navigator);
  const abs = (u: string) => new URL(u, location.href).href;
  const paths = oldSafari ? { mjs: abs(ortMjs), wasm: abs(ortWasm) } : { mjs: abs(ortAsyncMjs), wasm: abs(ortAsyncWasm) };
  loading ||= call({ type: "load", paths }, onProgress);
  loading.catch(() => (loading = null));
  return loading;
}

export async function toEnglish(text: string): Promise<string> {
  await load();
  return call({ type: "translate", text });
}
