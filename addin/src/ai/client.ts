/** The AI client for the provider chosen in AI settings. */
import { AiSettings, GeminiClient, ModelClient } from "./gemini";
import { OllamaClient } from "./ollama";

export function makeClient(s: AiSettings): ModelClient {
  return s.provider === "ollama" ? new OllamaClient(s) : new GeminiClient(s);
}

/** Is the chosen provider set up enough to try? (A local model needs no key.) */
export const isReady = (s: AiSettings): boolean => (s.provider === "ollama" ? true : s.apiKey.trim() !== "");
