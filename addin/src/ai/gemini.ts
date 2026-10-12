/**
 * Talking to Google's Gemini API from the page. The request carries the question and the sheet's profile
 * (see profile.ts): never rows. The reply is JSON that `run.ts` checks before anything runs.
 */
export interface AiSettings {
  enabled: boolean;
  apiKey: string;
  /** A Gemini model id; "gemini-2.5-flash" has a free tier. */
  model: string;
  /** Send the common values of category columns (state, status, 0/1 flags). Off = column names, types and ranges only. */
  shareValues: boolean;
}

export const DEFAULT_MODEL = "gemini-2.5-flash";
export const defaultSettings = (): AiSettings => ({ enabled: false, apiKey: "", model: DEFAULT_MODEL, shareValues: true });

export type AiErrorKind = "key" | "quota" | "network" | "bad" | "blocked";
export class AiError extends Error {
  constructor(message: string, readonly kind: AiErrorKind) { super(message); }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiClient {
  constructor(private readonly settings: AiSettings, private readonly fetchImpl: Fetch = (url, init) => fetch(url, init)) {}

  /** Send one request and return the model's reply parsed as JSON. */
  async ask(system: string, user: string, signal?: AbortSignal): Promise<unknown> {
    if (!this.settings.apiKey.trim()) throw new AiError("Add your Gemini API key in the AI settings first.", "key");
    let res;
    try {
      res = await this.fetchImpl(`${ENDPOINT}/${encodeURIComponent(this.settings.model || DEFAULT_MODEL)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.settings.apiKey.trim() },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 },
        }),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new AiError("I couldn't reach Gemini. Check the internet connection (or that this network allows generativelanguage.googleapis.com).", "network");
    }
    const raw = await res.text();
    if (!res.ok) {
      let detail = "";
      try { detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? ""; } catch { /* not JSON */ }
      if (res.status === 400 && /api key/i.test(detail)) throw new AiError("Gemini did not accept the API key. Check it in the AI settings.", "key");
      if (res.status === 401 || res.status === 403) throw new AiError("Gemini refused the request (key not allowed). Check the API key in the AI settings.", "key");
      if (res.status === 429) throw new AiError("Gemini's free limit was reached for now. Wait a minute and try again.", "quota");
      if (res.status === 404) throw new AiError(`Gemini has no model called “${this.settings.model}”. Change it in the AI settings.`, "bad");
      throw new AiError(`Gemini returned an error (${res.status}). ${detail}`.trim(), "bad");
    }
    let body: { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    try { body = JSON.parse(raw); } catch { throw new AiError("Gemini sent a reply I could not read.", "bad"); }
    if (body.promptFeedback?.blockReason) throw new AiError(`Gemini blocked this request (${body.promptFeedback.blockReason}).`, "blocked");
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new AiError("Gemini gave an empty answer. Try rephrasing the question.", "bad");
    try {
      return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
    } catch {
      throw new AiError("Gemini's answer was not in the expected format. Try again.", "bad");
    }
  }
}
