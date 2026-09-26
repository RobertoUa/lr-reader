// Summary prompt, the OpenAI call (plain fetch, no SDK) and the key-free hand-off to the chat apps.
// Claude goes through the Anthropic SDK in ai.ts, loaded only when used.
export const CLAUDE_MODELS: Record<string, string> = { "claude-opus-5": "Claude Opus 5", "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5" };
export const OPENAI_MODELS: Record<string, string> = { "gpt-5.5": "GPT-5.5", "gpt-6-sol": "GPT-6 Sol", "gpt-5.4-mini": "GPT-5.4 mini" };

export type Scope = "page" | "sofar" | "chapter";
export type Ask = { text: string; scope: Scope; title: string; sl: string; tl: string; outLang: string };

export const langName = (code: string) => new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;

export function prompt(a: Ask): { system: string; user: string } {
  return {
    system:
      `You summarize passages from a ${langName(a.sl)} book for someone learning ${langName(a.sl)} whose native language is ${langName(a.tl)}. ` +
      `Write the summary in ${langName(a.outLang)}${a.outLang === a.sl ? ", using simple words and short sentences" : ""}. ` +
      `Say what happens, who is involved and anything needed to follow the next part. ` +
      `For one page, 3 to 5 sentences; for a chapter or part of one, 2 or 3 short paragraphs. Plain text, no headings or lists.`,
    user: `${a.scope === "sofar" ? `Summarize the chapter "${a.title}" from its start up to where the reader stopped` : `Summarize this ${a.scope} of "${a.title}"`}:\n\n<text>\n${a.text}\n</text>`,
  };
}

export async function openaiSummarize(a: Ask, key: string, model: string, onText: (t: string) => void): Promise<string> {
  const p = prompt(a);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      reasoning_effort: "low",
      max_completion_tokens: 16000,
      messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
    }),
  });
  if (!r.ok || !r.body) {
    const e = await r.json().catch(() => null);
    throw new Error(`${r.status} ${e?.error?.message || r.statusText}`);
  }
  // Server-sent events: "data: {json}" lines, finished by "data: [DONE]".
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let out = "", buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const t = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "";
      out += t;
      if (t) onText(t);
    }
  }
  return out;
}

// Whole request as one message for the chat apps; they take it prefilled from ?q= when it fits a URL.
const MAX_URL = 6000;
export function chatText(a: Ask) {
  const p = prompt(a);
  return `${p.system}\n\n${p.user}`;
}
export function chatUrl(app: "claude" | "chatgpt", text: string) {
  const q = encodeURIComponent(text);
  const base = app === "claude" ? "https://claude.ai/new" : "https://chatgpt.com/";
  return q.length <= MAX_URL ? `${base}?q=${q}` : base;
}
export const fitsUrl = (text: string) => encodeURIComponent(text).length <= MAX_URL;
