/** The AI settings dialog and the "what I understood about your sheet" panel. */
import { AiError, AiSettings, DEFAULT_MODEL, GeminiClient, PRIVACY_VERSION, defaultSettings } from "./gemini";
import { ColumnProfile, describeColumn } from "./profile";

const KEY = "sheet-assistant-ai";

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AiSettings>;
      // Settings saved before the privacy guardrails: keep the key and model, start again in strict mode.
      if ((saved.privacyVersion ?? 0) < PRIVACY_VERSION) { saved.shareValues = false; saved.readResults = false; saved.privacyVersion = PRIVACY_VERSION; }
      return { ...defaultSettings(), ...saved };
    }
  } catch { /* storage blocked or damaged: use the defaults */ }
  return defaultSettings();
}

export function saveAiSettings(s: AiSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface AiUiHooks {
  /** Called after the settings are saved. */
  changed(s: AiSettings): void;
  /** Forget what the person confirmed earlier. */
  forget(): void;
}

/** Add the "AI" button (to the website's top bar, or the add-in's header) and its settings dialog. */
export function initAiUi(hooks: AiUiHooks): { open(): void; refresh(): void } {
  let settings = loadAiSettings();
  const dlg = el("dialog", "ai-dialog");
  dlg.setAttribute("aria-label", "AI settings");

  const title = el("h2", "", "AI settings");
  const on = el("input"); on.type = "checkbox"; on.id = "ai-on";
  const onLabel = el("label", "ai-row"); onLabel.append(on, document.createTextNode(" Use AI to understand my questions"));
  const keyLabel = el("label", "ai-field", "Gemini API key");
  const key = el("input"); key.type = "password"; key.autocomplete = "off"; key.placeholder = "Paste your key"; key.id = "ai-key";
  keyLabel.append(key);
  const keyHelp = el("p", "muted small");
  keyHelp.append("Get a free key at ");
  const link = el("a", "", "aistudio.google.com/apikey"); link.href = "https://aistudio.google.com/apikey"; link.target = "_blank"; link.rel = "noopener";
  keyHelp.append(link, ". The key stays in this browser only.");
  const modelLabel = el("label", "ai-field", "Model");
  const model = el("input"); model.type = "text"; model.id = "ai-model"; model.placeholder = DEFAULT_MODEL;
  modelLabel.append(model);
  const share = el("input"); share.type = "checkbox"; share.id = "ai-share";
  const shareLabel = el("label", "ai-row"); shareLabel.append(share, document.createTextNode(" Also share the common values of category columns (state, status, 0/1 flags)"));
  const what = el("div", "note");
  what.innerHTML = "<strong>What is sent to Google:</strong> your question, the column names, and for each column its type, range, share of empty cells and, if ticked above, its most common values when it has few different ones. "
    + "<strong>Never sent:</strong> rows, names, phone numbers, PAN, account numbers or ids. All calculations run on this computer. "
    + "A free Gemini key may let Google use prompts to improve its products, so use it with test or masked files only.";
  const status = el("p", "small"); status.setAttribute("role", "status");
  const row = el("div", "actions");
  const test = el("button", "", "Test the key"); test.type = "button";
  const forget = el("button", "", "Forget answers I confirmed"); forget.type = "button";
  const save = el("button", "primary", "Save"); save.type = "button";
  const close = el("button", "", "Close"); close.type = "button";
  row.append(test, forget, save, close);
  dlg.append(title, onLabel, keyLabel, keyHelp, modelLabel, shareLabel, what, status, row);
  document.body.append(dlg);

  const current = (): AiSettings => ({ ...settings, enabled: on.checked, apiKey: key.value.trim(), model: model.value.trim() || DEFAULT_MODEL, shareValues: share.checked });
  const fill = (): void => { on.checked = settings.enabled; key.value = settings.apiKey; model.value = settings.model; share.checked = settings.shareValues; status.textContent = ""; };

  const open = (): void => { fill(); if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", ""); };
  close.addEventListener("click", () => dlg.close());
  save.addEventListener("click", () => {
    settings = current();
    if (settings.enabled && !settings.apiKey) { status.textContent = "Paste your Gemini API key first."; return; }
    saveAiSettings(settings);
    hooks.changed(settings);
    dlg.close();
  });
  forget.addEventListener("click", () => { hooks.forget(); status.textContent = "Forgotten. I'll ask again next time."; });
  test.addEventListener("click", async () => {
    status.textContent = "Testing…";
    try {
      await new GeminiClient(current()).ask("Reply with the JSON object {\"ok\":true}.", "ping");
      status.textContent = "The key works.";
    } catch (e) {
      status.textContent = e instanceof AiError ? e.message : "The test failed.";
    }
  });

  const button = el("button", "ghost ai-button", "AI"); button.type = "button"; button.id = "open-ai";
  button.title = "AI settings";
  const refresh = (): void => { button.classList.toggle("on", settings.enabled && !!settings.apiKey); button.textContent = settings.enabled && settings.apiKey ? "AI: on" : "AI: off"; };
  button.addEventListener("click", open);
  const top = document.getElementById("top");
  const grow = top?.querySelector(".grow");
  if (top && grow) grow.after(button);
  else (document.querySelector("header") ?? document.body).append(button);
  refresh();
  hooks.changed(settings);
  return { open, refresh: () => { settings = loadAiSettings(); refresh(); } };
}

/** Show what the assistant understood about each column, so the person can see it is reading the sheet correctly. */
export function renderUnderstood(profiles: ColumnProfile[], totalColumns: number): void {
  let box = document.getElementById("understood") as HTMLDetailsElement | null;
  if (!box) {
    box = el("details") as HTMLDetailsElement;
    box.id = "understood";
    const anchor = document.getElementById("columns-box");
    if (anchor) anchor.after(box); else return;
  }
  box.replaceChildren();
  const summary = el("summary", "", "What I understood about your sheet");
  const list = el("div", "understood-list");
  for (const p of profiles) {
    const line = el("div", "understood-row");
    line.append(el("strong", "", p.name), el("span", `role role-${p.role}`, p.role));
    line.append(el("span", "muted small", describeColumn(p).replace(/^[^;]*;?\s*/, "")));
    list.append(line);
  }
  box.append(summary);
  if (totalColumns > profiles.length) box.append(el("p", "muted small", `Showing the ${profiles.length} columns read so far, of ${totalColumns}.`));
  box.append(list);
  box.classList.remove("hidden");
}
