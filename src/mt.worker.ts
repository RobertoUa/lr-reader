// Runs the offline Spanish->English model off the main thread, so loading and translating never freeze the page.
import { env, pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/opus-mt-es-en";
let pipe: Promise<any> | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { id, type, text, paths } = e.data;
  try {
    if (type === "load") {
      pipe ||= (async () => {
        env.backends.onnx.wasm!.wasmPaths = paths;
        const loaded: Record<string, number> = {}, total: Record<string, number> = {};
        const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
        return pipeline("translation", MODEL, {
          dtype: "q8",
          progress_callback: (p: any) => {
            if (p.status !== "progress" || !p.total) return;
            loaded[p.file] = p.loaded;
            total[p.file] = p.total;
            postMessage({ id, progress: Math.floor((100 * sum(loaded)) / sum(total)) });
          },
        });
      })();
      pipe.catch(() => (pipe = null));
      await pipe;
      postMessage({ id, done: true });
    } else {
      const out = await (await pipe!)(text);
      postMessage({ id, done: true, text: out[0].translation_text });
    }
  } catch (err) {
    postMessage({ id, error: (err as Error)?.message || String(err) });
  }
};
