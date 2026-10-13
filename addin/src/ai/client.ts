/** The AI client for the provider chosen in AI settings. */
import { AiSettings, GeminiClient, ModelClient } from "./gemini";
import { OllamaClient } from "./ollama";

/** The company key built into the site at publish time (empty when none was set). */
export const BUILTIN_KEY: string = (import.meta.env?.VITE_BUILTIN_GEMINI_KEY ?? "").trim();

/** The key a Gemini request will use: the person's own if they pasted one, otherwise the built-in key. */
export const keyFor = (s: AiSettings, builtin = BUILTIN_KEY): string => s.apiKey.trim() || builtin;
export const usesBuiltinKey = (s: AiSettings, builtin = BUILTIN_KEY): boolean => s.provider !== "ollama" && !s.apiKey.trim() && !!builtin;

export function makeClient(s: AiSettings, builtin = BUILTIN_KEY): ModelClient {
  if (s.provider === "ollama") return new OllamaClient(s);
  return new GeminiClient(s.apiKey.trim() ? s : { ...s, apiKey: builtin });
}

/** Is the chosen provider set up enough to try? (A local model needs no key; Gemini can use the built-in key.) */
export const isReady = (s: AiSettings, builtin = BUILTIN_KEY): boolean => (s.provider === "ollama" ? true : keyFor(s, builtin) !== "");
