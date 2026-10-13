/** Vite turns `?url` imports into the asset's URL. */
declare module "*?url" {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  /** A Gemini key baked in at build time (GitHub secret GEMINI_API_KEY), so the team needs no key of its own. */
  readonly VITE_BUILTIN_GEMINI_KEY?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
