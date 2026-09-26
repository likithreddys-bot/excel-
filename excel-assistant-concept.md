# Natural-Language Excel Assistant — Product Concept

Sep 26, 2026

## Vision

Most people who touch spreadsheets every day aren't spreadsheet experts. They know exactly what result they want — "split this into three sheets by region," "pull out anyone who hasn't paid in 30 days" — but not the formula, filter, or shortcut to get there. Today that gap means either learning Excel properly, bugging a colleague who "knows Excel," or doing it manually row by row.

The idea: a platform where the person describes the outcome in plain language (typed or spoken), and the system does the actual spreadsheet work — cleaning, filtering, splitting, joining, summarizing — and hands back a finished file or view in seconds.

**Who it's for:**

- Ops, sales, HR, and finance staff who live in spreadsheets but never learned formulas or pivot tables
- People who know *some* Excel but not enough for the specific task in front of them
- Anyone who knows Excel fine but wants the busywork gone

**The core bet:** the bottleneck isn't the computation (a computer can filter 43,000 rows instantly) — it's translating a person's intent into the right spreadsheet operations. That translation is exactly what a language model is good at.

## Core user experience

Walking through your 43K-user example end to end:

1. **User uploads a file** — drag-and-drop or paste into the chat (CSV or XLSX). The system parses it and shows a quick preview: row count, column names, a sample of a few rows.
2. **User types or speaks the ask**, e.g. *"Segregate this by signup plan into separate sheets, and inside each sheet only keep users where last\_active is in the last 90 days. Keep columns name, email, plan, last\_active."*
3. **The system asks only if something is genuinely ambiguous** — e.g. if "plan" could mean two different columns, or a date format is unclear — otherwise it does not interrupt with clarifying questions for things it can infer confidently.
4. **It shows what it's about to do in plain English before running it** — a short confirmation like "I'll split by `plan` into 4 sheets, filter each to `last_active` within 90 days, keep 4 columns. \~43,210 rows → estimated 11,400 rows after filtering." This builds trust and catches misunderstandings before they cost time.
5. **It executes and returns a result in seconds** — a downloadable spreadsheet, plus an inline summary (row counts per sheet, what was dropped, any rows it couldn't confidently place).
6. **The user can immediately follow up conversationally** — "actually also sort each sheet by last\_active descending" — without re-uploading or re-describing everything.

The experience should feel like delegating to a very fast, very literal assistant — not like writing formulas in a chat box.

## Feature scope

**MVP (prove the core loop)**

- Upload CSV/XLSX (single file, up to \~100K rows)
- Text chat commands only (voice comes later)
- Core operations: filter rows, select/drop columns, sort, segregate/split into multiple sheets or files by a column value, basic dedupe, basic aggregation (count/sum/average by group)
- "Here's what I'm about to do" confirmation step before executing
- Download result as XLSX or CSV
- Undo / redo and a visible history of commands applied to the file

**Phase 2 (make it trustworthy and sticky)**

- Voice input
- Multi-file joins/merges ("combine this with last month's file, matching on user\_id")
- Formula generation for people who *do* want the formula, not just the result
- In-place editing of a live spreadsheet view (not just batch upload → download)
- Templates/saved commands for recurring tasks ("run my weekly segregation")
- Data quality flags (duplicate rows, inconsistent formats, missing values) surfaced proactively

**Phase 3 (platform expansion)**

- Google Sheets integration, not just file upload
- Scheduled/recurring jobs ("do this every Monday at 9am")
- Team accounts with shared history and templates
- API for other tools to call the same natural-language engine
- Charting/visualization requested in natural language

## Technical approach

The hard problem is turning a fuzzy sentence into a precise, reversible spreadsheet operation the engine can execute deterministically. A reasonable pattern:

1. **Parse the file** into a structured form (pandas DataFrame or similar) — not just text, so operations are exact and fast even at hundreds of thousands of rows.
2. **LLM as planner, not executor.** The user's sentence goes to an LLM that turns it into a small, structured plan — a sequence of typed operations (`filter`, `split_by`, `select_columns`, `sort`, `groupby_agg`, `dedupe`, `join`) with explicit parameters, not free-form code the model "just runs." This keeps behavior predictable and auditable.
3. **A deterministic execution engine** (e.g. pandas/Polars under the hood, or direct spreadsheet-engine libraries) actually performs each operation on the real data. The LLM never touches the numbers directly — it only chooses and configures operations.
4. **A validation/preview layer** runs the plan against the data, computes what would change (row counts, affected columns), and shows that summary to the user before committing — this is what makes the "here's what I'm about to do" confirmation possible and builds trust.
5. **Voice input** is just speech-to-text feeding the same text pipeline — no separate logic needed.

**Suggested stack directions** (to validate, not final):

- Backend: Python (pandas/Polars for data ops), FastAPI or similar
- File handling: openpyxl/xlsxwriter for XLSX read/write
- LLM layer: Claude for intent parsing → structured plan (function calling / tool use maps naturally onto "pick an operation and its parameters")
- Frontend: web app with a chat panel + spreadsheet preview pane side by side, so the user always sees the data, not just chat bubbles
- For large files: process server-side and stream/paginate the preview rather than loading everything into the browser

## Key challenges & open questions

- **Ambiguity resolution.** "Segregate by region" is fine when there's one obvious region column; real files have inconsistent headers, abbreviations, and duplicate-ish columns. The system needs a good sense of when to just do the sensible thing versus when to stop and ask — asking too often kills the "just type what you want" promise.
- **Trust and accuracy.** If the system silently drops or misclassifies rows, users lose confidence fast — especially with something like 43K rows they can't manually check. The preview/confirmation step and clear "X rows were excluded because Y" reporting are not optional, they're core to adoption.
- **Scale and performance.** 43K rows is easy; some users will bring millions of rows or 50+ column files. Needs a real data-processing backend, not spreadsheet-formula-style execution.
- **Data privacy.** Uploaded files may contain sensitive personal or financial data (this example is literally 43K user records). Needs clear handling: where files are stored, for how long, whether they're used for anything beyond the immediate task.
- **Voice UX for spreadsheet work.** Describing multi-condition filters by voice is harder than typing them; may need voice for simple commands and text/UI for complex multi-step ones.
- **Where's the line with existing tools?** Excel and Google Sheets already have some AI features (Copilot, Gemini). Worth being clear on the wedge: is it speed, is it for people who'd never touch Excel formulas at all, is it bulk/batch operations Excel isn't built for?

## Suggested next steps

1. Pick 3–5 real, messy files you'd actually want to run through this (your 43K-user file is a good one) and write out, in plain language, exactly what you'd ask for on each — this becomes the test set for how well intent-parsing needs to work.
2. Build a rough prototype of just the core loop: upload → text command → structured plan → pandas execution → preview → download. Skip auth, accounts, voice, everything else.
3. Test it on those real files and see where it guesses wrong — that tells you which operations need the most work (filtering and splitting are usually easier than joins and multi-step transforms).
4. Decide the wedge/positioning question above before going further, since it shapes who you build the UI for.

Happy to go deeper on any one of these next — for example, sketching the exact structured-plan format (the JSON schema an LLM would output for something like the 43K-user example), or mocking up what the chat + spreadsheet-preview screen could look like.
