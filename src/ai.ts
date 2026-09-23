import Anthropic from "@anthropic-ai/sdk";


const langName = (code: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;

export async function summarize(o: {
  apiKey: string;
  model: string;
  text: string;
  scope: "page" | "chapter";
  title: string;
  sl: string;
  tl: string;
  outLang: string;
  onText: (delta: string) => void;
}): Promise<string> {
  // The key stays on this device; the browser calls the API directly because the app has no server.
  const client = new Anthropic({ apiKey: o.apiKey, dangerouslyAllowBrowser: true });
  const current = o.model === "claude-opus-5" || o.model === "claude-sonnet-5";
  const stream = client.beta.messages.stream({
    model: o.model,
    max_tokens: 16000,
    // Summaries are routine work; low effort keeps them fast. Haiku 4.5 does not take effort.
    ...(current ? { output_config: { effort: "low" as const } } : {}),
    ...(o.model === "claude-opus-5" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    system:
      `You summarize passages from a ${langName(o.sl)} book for someone learning ${langName(o.sl)} whose native language is ${langName(o.tl)}. ` +
      `Write the summary in ${langName(o.outLang)}${o.outLang === o.sl ? ", using simple words and short sentences" : ""}. ` +
      `Say what happens, who is involved and anything needed to follow the next part. ` +
      `For one page, 3 to 5 sentences; for a chapter, 2 or 3 short paragraphs. Plain text, no headings or lists.`,
    messages: [{ role: "user", content: `Summarize this ${o.scope} of "${o.title}":\n\n<text>\n${o.text}\n</text>` }],
  });
  stream.on("text", (t) => o.onText(t));
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to summarize this text");
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
