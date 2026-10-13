/**
 * A model that runs on this computer (or a server on the company network) through Ollama. Requests go only to that
 * server, so nothing about the files leaves the network, and nothing is used to train anyone's model.
 * Ollama's /api/chat takes OpenAI-style messages and tools; the agent's Gemini-style turns are translated here.
 */
import { AiError, AiSettings, Content, Fetch, FunctionDeclaration, ModelClient, Part } from "./gemini";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

interface ToolCall { function: { name: string; arguments?: Record<string, unknown> | string } }
interface Message { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_name?: string }

/** Models known to call tools well, best first; any installed one is better than none. */
const PREFERRED = [/qwen3/i, /qwen2\.5/i, /llama3\.[123]/i, /mistral-(?:nemo|small)/i, /gpt-oss/i, /granite3/i, /command-r/i, /firefunction/i];

export function pickLocalModel(names: string[]): string | null {
  for (const re of PREFERRED) { const hit = names.find((n) => re.test(n) && !/embed/i.test(n)); if (hit) return hit; }
  return names.find((n) => !/embed/i.test(n)) ?? null;
}

/** The agent's turns (Gemini shape) as Ollama chat messages. */
export function toMessages(system: string, contents: Content[]): Message[] {
  const out: Message[] = [{ role: "system", content: system }];
  for (const c of contents) {
    const text = c.parts.map((p) => p.text ?? "").join("");
    if (c.role === "model") {
      const calls = c.parts.filter((p) => p.functionCall).map((p) => ({ function: { name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} } }));
      out.push({ role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const p of c.parts.filter((x) => x.functionResponse)) out.push({ role: "tool", tool_name: p.functionResponse!.name, content: JSON.stringify(p.functionResponse!.response) });
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

export class OllamaClient implements ModelClient {
  guard: (body: Record<string, unknown>) => void = () => {};
  onSend: (body: Record<string, unknown>) => void = () => {};
  onStatus: (message: string) => void = () => {};
  onModelChange: (model: string) => void = () => {};

  constructor(private readonly settings: AiSettings, private readonly fetchImpl: Fetch = (url, init) => fetch(url, init)) {}

  private get base(): string { return (this.settings.ollamaUrl || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, ""); }

  private unreachable(): AiError {
    return new AiError(
      `I couldn't reach the local model at ${this.base}. Check that Ollama is running, and that it allows this page: `
      + `start it with OLLAMA_ORIGINS set to ${typeof location !== "undefined" ? location.origin : "this site's address"} (see "How to set up a local model" in AI settings).`,
      "network");
  }

  /** Models installed in Ollama. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    let res;
    try { res = await this.fetchImpl(`${this.base}/api/tags`, { method: "GET", headers: {}, signal }); } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw this.unreachable();
    }
    if (!res.ok) return [];
    try { return ((JSON.parse(await res.text()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name); } catch { return []; }
  }

  async ask(system: string, user: string, signal?: AbortSignal): Promise<unknown> {
    const msg = await this.send({ messages: [{ role: "system", content: system }, { role: "user", content: user }], format: "json" }, signal);
    try { return JSON.parse(msg.content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")); } catch {
      throw new AiError("The local model's answer was not in the expected format. Try again, or use a larger model.", "bad");
    }
  }

  async chat(system: string, contents: Content[], tools: FunctionDeclaration[], signal?: AbortSignal): Promise<Content> {
    const msg = await this.send({
      messages: toMessages(system, contents),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} } } })),
    }, signal);
    const parts: Part[] = [];
    if (msg.content?.trim()) parts.push({ text: msg.content });
    for (const call of msg.tool_calls ?? []) {
      let args = call.function.arguments ?? {};
      if (typeof args === "string") { try { args = JSON.parse(args) as Record<string, unknown>; } catch { args = {}; } }
      parts.push({ functionCall: { name: call.function.name, args: args as Record<string, unknown> } });
    }
    if (!parts.length) throw new AiError("The local model gave an empty answer. Try rephrasing, or use a larger model.", "bad");
    return { role: "model", parts };
  }

  private async send(extra: Record<string, unknown>, signal?: AbortSignal, switched = false): Promise<Message> {
    const model = (this.settings.ollamaModel || DEFAULT_OLLAMA_MODEL).trim();
    const body = { model, stream: false, options: { temperature: 0, num_ctx: 16384 }, ...extra };
    if (!switched) { this.guard(body); this.onSend(body); }
    this.onStatus("The local model is thinking…");
    let res;
    try {
      res = await this.fetchImpl(`${this.base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw this.unreachable();
    } finally {
      this.onStatus("");
    }
    const raw = await res.text();
    if (res.status === 404 && !switched) {
      // The model isn't installed: use one that is.
      const other = pickLocalModel(await this.listModels(signal));
      if (other && other !== model) {
        this.settings.ollamaModel = other;
        this.onModelChange(other);
        return this.send(extra, signal, true);
      }
      throw new AiError(`The local model “${model}” is not installed. In a terminal run: ollama pull ${DEFAULT_OLLAMA_MODEL}`, "bad");
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (JSON.parse(raw) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
      if (/does not support tools/i.test(detail)) throw new AiError(`The local model “${model}” can't use tools. Install one that can: ollama pull ${DEFAULT_OLLAMA_MODEL}`, "bad");
      throw new AiError(`The local model returned an error (${res.status}). ${detail}`.trim(), "bad");
    }
    try { return (JSON.parse(raw) as { message: Message }).message; } catch { throw new AiError("The local model sent a reply I could not read.", "bad"); }
  }
}

