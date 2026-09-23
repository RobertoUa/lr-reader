import Anthropic from "@anthropic-ai/sdk";
import { prompt, type Ask } from "./summary";

export async function summarize(a: Ask, apiKey: string, model: string, onText: (delta: string) => void): Promise<string> {
  // The key stays on this device; the browser calls the API directly because the app has no server.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const current = model === "claude-opus-5" || model === "claude-sonnet-5";
  const p = prompt(a);
  const stream = client.beta.messages.stream({
    model,
    max_tokens: 16000,
    // Summaries are routine work; low effort keeps them fast. Haiku 4.5 does not take effort.
    ...(current ? { output_config: { effort: "low" as const } } : {}),
    ...(model === "claude-opus-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    system: p.system,
    messages: [{ role: "user", content: p.user }],
  });
  stream.on("text", (t) => onText(t));
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to summarize this text");
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
