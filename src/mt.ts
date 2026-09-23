// Offline Spanish->English translation with a small model run in the browser, for sentences that were
// not prepared. There is no good es->uk model that runs here (the one tried answered in Russian).
// The onnxruntime files are served from this app: by default transformers.js imports them from a CDN,
// which would run third-party code next to the API keys, and would not be cached for offline use.
import ortAsyncMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortAsyncWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

const MODEL = "Xenova/opus-mt-es-en";
type Translate = (text: string) => Promise<{ translation_text: string }[]>;
let pipe: Promise<Translate> | null = null;

export const supported = (sl: string) => sl === "es";

export function load(onProgress?: (pct: number) => void): Promise<Translate> {
  pipe ||= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    // Same choice transformers.js makes: Safari before 26 without WebGPU needs the non-asyncify build.
    const oldSafari = Number(/Version\/(\d+).*Safari/.exec(navigator.userAgent)?.[1] ?? 99) < 26 && !("gpu" in navigator);
    env.backends.onnx.wasm!.wasmPaths = oldSafari ? { mjs: ortMjs, wasm: ortWasm } : { mjs: ortAsyncMjs, wasm: ortAsyncWasm };
    const loaded: Record<string, number> = {}, total: Record<string, number> = {};
    return (await pipeline("translation", MODEL, {
      dtype: "q8",
      progress_callback: (p: any) => {
        if (p.status !== "progress" || !p.total) return;
        loaded[p.file] = p.loaded;
        total[p.file] = p.total;
        const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
        onProgress?.(Math.floor((100 * sum(loaded)) / sum(total)));
      },
    })) as unknown as Translate;
  })();
  pipe.catch(() => (pipe = null));
  return pipe;
}

export async function toEnglish(text: string): Promise<string> {
  return (await (await load())(text))[0].translation_text;
}
