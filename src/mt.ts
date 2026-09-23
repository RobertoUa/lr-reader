// Offline Spanish->English translation with a small model run in the browser, for sentences that were
// not prepared. There is no good es->uk model that runs here (the one tried answered in Russian).
const MODEL = "Xenova/opus-mt-es-en";
type Translate = (text: string) => Promise<{ translation_text: string }[]>;
let pipe: Promise<Translate> | null = null;

export const supported = (sl: string) => sl === "es";

export function load(onProgress?: (pct: number) => void): Promise<Translate> {
  pipe ||= (async () => {
    const { pipeline } = await import("@huggingface/transformers");
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
