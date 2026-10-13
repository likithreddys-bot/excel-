/**
 * Talking to Google's Gemini API from the page. The request carries the question and the sheet's profile
 * (see profile.ts): never rows. The reply is JSON that `run.ts` checks before anything runs.
 */
export interface AiSettings {
  enabled: boolean;
  apiKey: string;
  /** A Gemini model id; Flash models have a free tier. */
  model: string;
  /** Send the common values of category columns (state, status, 0/1 flags). Off = column names, types and ranges only. */
  shareValues: boolean;
  /** Let the agent read small summary results (at most 60 rows, no personal or id columns) so it can explain them. */
  readResults: boolean;
  /** Set once the person has seen the privacy choices (older saved settings start in strict mode). */
  privacyVersion?: number;
}

/** Google's alias for its current Flash model (fast, with a free tier). If a key can't use it, a working model is looked up. */
export const DEFAULT_MODEL = "gemini-flash-latest";
/** Strict by default: only column names, types and ranges leave the computer. */
export const defaultSettings = (): AiSettings => ({ enabled: false, apiKey: "", model: DEFAULT_MODEL, shareValues: false, readResults: false, privacyVersion: PRIVACY_VERSION });
export const PRIVACY_VERSION = 2;

/** One turn of a Gemini conversation, kept exactly as the API returned it (parts may carry thought signatures). */
export interface Content { role: "user" | "model"; parts: Part[] }
export interface Part {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  [other: string]: unknown;
}
export interface FunctionDeclaration { name: string; description: string; parameters?: Record<string, unknown> }

export type AiErrorKind = "key" | "quota" | "network" | "bad" | "blocked" | "busy";
export class AiError extends Error {
  constructor(message: string, readonly kind: AiErrorKind) { super(message); }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * The best model for this app among those a key can use: a Flash model that supports generateContent, newest version
 * first, skipping specialised ones (image, audio, live, embedding, thinking-only) and previews when a stable one exists.
 */
export function pickModel(models: { name: string; supportedGenerationMethods?: string[] }[]): string | null {
  return rankModels(models)[0] ?? null;
}

/** Models this app can use, best first (see pickModel). */
export function rankModels(models: { name: string; supportedGenerationMethods?: string[] }[]): string[] {
  const usable = models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini/i.test(n) && !/image|audio|tts|live|embed|vision|thinking|robotics|computer|exp/i.test(n));
  const version = (n: string): number => Number(/gemini-(\d+(?:\.\d+)?)/i.exec(n)?.[1] ?? 0);
  const score = (n: string): number =>
    (/flash/i.test(n) ? 1000 : 0) + (/latest/i.test(n) ? 500 : 0) - (/lite/i.test(n) ? 300 : 0) - (/preview/i.test(n) ? 200 : 0) + version(n) * 10;
  return usable.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

/** Google is overloaded or had a hiccup: worth trying again shortly. */
const BUSY = new Set([500, 502, 503, 504]);
/** Waits before retrying the same model when Google is busy. */
export const BUSY_WAITS_MS = [2000, 5000];

export class GeminiClient {
  /** Called when the client switched to another model because the chosen one is not available. */
  onModelChange: (model: string) => void = () => {};
  /** Checks every request before it is sent; throws to stop it (the privacy guard). */
  guard: (body: Record<string, unknown>) => void = () => {};
  /** Called with every request that is actually sent (for the "What was sent" log). */
  onSend: (body: Record<string, unknown>) => void = () => {};
  /** Progress while waiting on a busy Gemini ("Gemini is busy, trying again…"). */
  onStatus: (message: string) => void = () => {};
  /** How to wait between retries (replaced in tests). */
  wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("Stopped", "AbortError")); }, { once: true });
  });

  constructor(private readonly settings: AiSettings, private readonly fetchImpl: Fetch = (url, init) => fetch(url, init)) {}

  /** The models this key can use (names without the "models/" prefix). */
  async listModels(signal?: AbortSignal): Promise<{ name: string; supportedGenerationMethods?: string[] }[]> {
    let res;
    try {
      res = await this.fetchImpl(`${ENDPOINT}?pageSize=1000`, { method: "GET", headers: { "x-goog-api-key": this.settings.apiKey.trim() }, signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError("I couldn't reach Gemini. Check the internet connection (or that this network allows generativelanguage.googleapis.com).", "network");
    }
    const raw = await res.text();
    if (!res.ok) return [];
    try { return (JSON.parse(raw) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }).models ?? []; } catch { return []; }
  }

  /** Send one request and return the model's reply parsed as JSON. */
  async ask(system: string, user: string, signal?: AbortSignal): Promise<unknown> {
    const content = await this.generate({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 },
    }, signal);
    const text = content.parts.map((p) => p.text ?? "").join("");
    if (!text.trim()) throw new AiError("Gemini gave an empty answer. Try rephrasing the question.", "bad");
    try {
      return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
    } catch {
      throw new AiError("Gemini's answer was not in the expected format. Try again.", "bad");
    }
  }

  /** One step of a tool-using conversation: returns the model's turn (text and/or function calls). */
  async chat(system: string, contents: Content[], tools: FunctionDeclaration[], signal?: AbortSignal): Promise<Content> {
    return this.generate({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    }, signal);
  }

  private async generate(body: Record<string, unknown>, signal?: AbortSignal): Promise<Content> {
    if (!this.settings.apiKey.trim()) throw new AiError("Add your Gemini API key in the AI settings first.", "key");
    this.guard(body);
    this.onSend(body);
    let model = this.settings.model || DEFAULT_MODEL;
    let switched = false;
    let alternates: string[] | null = null;
    let busyTries = 0;
    for (;;) {
      const { status, raw } = await this.post(model, body, signal);
      if (status === 200) return this.content(raw);
      let detail = "";
      try { detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* not JSON */ }
      if (status === 400 && /api key/i.test(detail)) throw new AiError("Gemini did not accept the API key. Check it in the AI settings.", "key");
      if (status === 401 || status === 403) throw new AiError("Gemini refused the request (key not allowed). Check the API key in the AI settings.", "key");
      if (status === 429) throw new AiError("Gemini's free limit was reached for now. Wait a minute and try again.", "quota");
      if (status === 404 && !switched) {
        // The model was retired or renamed: switch to the best one this key can use, and keep it.
        const better = pickModel(await this.listModels(signal));
        if (better && better !== model) {
          switched = true;
          model = this.settings.model = better;
          this.onModelChange(better);
          continue;
        }
      }
      if (status === 404) throw new AiError(`Gemini has no model called “${model}”, and I couldn't find another one to use with this key. Check the key in AI settings.`, "bad");
      if (BUSY.has(status)) {
        // Google is overloaded: wait and retry, then try other Flash models for this request (the saved choice stays).
        if (busyTries < BUSY_WAITS_MS.length) {
          this.onStatus("Gemini is busy right now, trying again…");
          await this.wait(BUSY_WAITS_MS[busyTries++], signal);
          continue;
        }
        alternates ??= rankModels(await this.listModels(signal)).filter((m) => m !== model).slice(0, 2);
        const next = alternates.shift();
        if (next) {
          this.onStatus(`Gemini is busy right now, trying ${next}…`);
          model = next;
          continue;
        }
        throw new AiError("Gemini is overloaded right now (Google's servers are busy). Wait a minute and try again.", "busy");
      }
      throw new AiError(`Gemini returned an error (${status}). ${detail}`.trim(), "bad");
    }
  }

  private async post(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; raw: string }> {
    let res;
    try {
      res = await this.fetchImpl(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.settings.apiKey.trim() },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError("I couldn't reach Gemini. Check the internet connection (or that this network allows generativelanguage.googleapis.com).", "network");
    }
    return { status: res.ok ? 200 : res.status || 500, raw: await res.text() };
  }

  private content(raw: string): Content {
    let parsed: { candidates?: { content?: Content; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    try { parsed = JSON.parse(raw); } catch { throw new AiError("Gemini sent a reply I could not read.", "bad"); }
    if (parsed.promptFeedback?.blockReason) throw new AiError(`Gemini blocked this request (${parsed.promptFeedback.blockReason}).`, "blocked");
    const content = parsed.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      const why = parsed.candidates?.[0]?.finishReason;
      throw new AiError(`Gemini gave an empty answer${why ? ` (${why})` : ""}. Try rephrasing the question.`, "bad");
    }
    return { role: "model", parts: content.parts };
  }
}
