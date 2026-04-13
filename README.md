# Vaso

Vaso ("eye" in Suvelinian) is an LLM-powered lore context panel for Obsidian worldbuilding vaults. As you write, Vaso runs a three-layer semantic search across your notes and synthesises the most relevant established facts in a sidebar — so contradictions and forgotten details surface before they make it into the page.

Desktop-only. Works with local and remote LLMs (Ollama, LM Studio, OpenRouter, or any OpenAI-compatible endpoint).

---

## What it does

- **Live lore context.** A sidebar view that updates as you type. Three ranked layers of matches feed the LLM:
  - **L0** — chunks most similar to the paragraph under your cursor (optionally including the paragraphs before and after). Depth configurable: matched chunk only, nearby chunks (±N), or the full source page.
  - **L1** — whole-note relevance. The top pages by max similarity across every chunk of the note you're writing, sent in full (truncated at a word limit).
  - **L2** — broad context. Additional chunks from pages not already in L0 or L1.
- **Streaming responses with status phases.** `loading → processing → reasoning → generating → done`. Reasoning tokens (from models that support them) appear in a collapsible "Thinking…" block.
- **Per-file response cache.** The last synthesis for each note is kept on disk and replayed instantly when the sources haven't changed.
- **Incremental indexing.** File modifications trigger a debounced re-embed of just the affected files. Full rebuilds are manual.
- **Endpoint failover.** Configure multiple embedding and inference endpoints; Vaso health-checks them in order and uses the first reachable one.
- **Stop button + lock.** A stop button in the sidebar header aborts the in-flight request. While a response is streaming, edits don't stack new calls — the current one finishes first.
- **Multi-provider.** One settings UI covers Ollama, LM Studio, OpenRouter, and generic OpenAI-compatible servers (vLLM, LocalAI, llama.cpp `--api`, text-generation-webui).
- **Configurable everything.** Chunk size/overlap, L0/L1/L2 counts, debounce, callout stripping, frontmatter stripping, per-endpoint custom params (merged into request bodies), thinking-mode control, keep-alive, temperature.

---

## Install

### From the latest release

1. Go to the project's Releases / Packages page and download `vaso-latest.zip` (or a specific `vaso-X.Y.Z.zip`).
2. Unzip into your vault: `<vault>/.obsidian/plugins/vaso/`. The folder should contain `main.js`, `manifest.json`, and `styles.css`.
3. Open Obsidian → Settings → Community plugins → enable **Vaso**.

### Build from source

```sh
git clone <repo-url>
cd vaso
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/vaso/` and enable the plugin.

---

## First-time setup

1. **Pick a provider.** Open Settings → Vaso. The default is a local Ollama instance at `http://localhost:11434`.
2. **Configure at least one embedding endpoint and one inference endpoint.** Paste the URL, set the model, click "Load models" to autofill. If the provider supports it (Ollama, LM Studio native), model info populates the context-window slider and bulk-imports the model's default parameters.
3. **Set your index scope.** By default Vaso indexes nothing. Add one directory per line under *Index scope → Indexed directories* (e.g. `Geography`, `Characters`, `Religion`). Toggle *Index root files* if you want loose root-level notes included.
4. **Build the index.** Use the command palette: **Vaso: Rebuild vault index**. On first launch, Vaso auto-triggers a build if no cached index is found.
5. **Open the context panel.** Command palette → **Vaso: Open lore context panel**. Start writing in a note inside an indexed directory — context appears within a couple of seconds.

---

## Providers

| Provider         | Chat streaming                          | Reasoning support | Auth         | Model info  |
| ---------------- | --------------------------------------- | ----------------- | ------------ | ----------- |
| **Ollama**       | NDJSON via `/api/chat`                  | `think` field     | none         | `/api/show` |
| **LM Studio**    | Native `/api/v1/chat` (rich SSE events) + `/v1/chat/completions` fallback | reasoning events + `reasoning_content` in fallback | optional | `/api/v0/models/list` |
| **OpenRouter**   | SSE via `/chat/completions`             | `reasoning` effort levels | API key required | via `/models` |
| **OpenAI-compat** (vLLM, LocalAI, llama.cpp, etc.) | SSE via `/v1/chat/completions` | delta.reasoning_content | optional    | —           |

Per-endpoint features exposed in settings:
- **Context window (num_ctx)** — power-of-2 slider; for LM Studio, Vaso checks whether the model is already loaded at the requested size before issuing a load request.
- **Keep-alive** (Ollama) — duration string controlling how long the model stays loaded after a request.
- **Temperature** (inference only).
- **Thinking mode** (Ollama + OpenRouter) — off / on / low / medium / high.
- **Custom parameters** — any JSON-safe key/value, merged into the request body. Prefix a key with `options.` for Ollama's nested `options` object; the prefix is stripped automatically for other providers.
- **Unload all models** (Ollama, LM Studio) — free VRAM from the settings tab.

---

## Commands

| Command                        | Action                                            |
| ------------------------------ | ------------------------------------------------- |
| **Open lore context panel**    | Reveals the sidebar view.                         |
| **Rebuild vault index**        | Full re-embed of every in-scope file.             |

File saves inside indexed directories automatically trigger an incremental index update (debounced).

Sidebar header buttons: `↻` manual refresh (bust cache), `⏹` stop the in-flight response.

---

## Settings reference

- **System prompt** — the prompt used to synthesise the context. Edit freely; the default asks for 3–6 bullets with page citations.
- **Writing context (words)** — how much of the current note feeds the prompt alongside the retrieved lore. `0` sends the full file.
- **Strip frontmatter / Strip callouts / Callout whitelist** — clean content before sending to the LLM.
- **L0 chunks / depth / nearby radius / include neighbor paragraphs** — paragraph-focused retrieval.
- **L1 chunks / L2 chunks / L1 max page words** — whole-note and broad-context layers.
- **Chunk size / overlap** — indexing granularity.
- **Index scope** — root files toggle + directory whitelist.
- **Debounces** — edit refresh, note-switch refresh, and index auto-update (set to `0` to disable auto-updates entirely).
- **Debug logging** — writes to `<plugin-dir>/vaso-debug.log` with a configurable max size (rotated by deletion).

---

## Data & privacy

- Vaso stores three files inside its plugin directory:
  - `vaso-index.json` — chunk embeddings (vectors + chunk text).
  - `vaso-llm-cache.json` — most recent synthesised response per file, keyed by source chunk IDs (LRU, capped at 200 entries).
  - `vaso-debug.log` — verbose log when debug logging is enabled.
- **Nothing leaves your machine unless you point Vaso at a remote endpoint** (OpenRouter, a remote Ollama, a Tailscale-reachable LM Studio host, etc.). With local Ollama or local LM Studio the vault contents never leave your device.
- When a remote endpoint is used, the prompt includes: the cleaned current-note excerpt, the configured number of matched chunks, and the LLM system prompt. Full source pages are only included for L1 matches and are truncated at the configured word limit.

---

## Development

```sh
npm install
npm run dev        # watch build (esbuild, inline sourcemap)
npm run build      # typecheck + production build (minified, no sourcemap)
```

## Disclaimer

Vaso is built to work with my workflow. While I do accept feature requests and contributions to this project, please contact me in advance or feel free to work the project.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [`LICENSE`](LICENSE) for the full text.

In short: you're free to use, study, modify, and redistribute Vaso, but derivatives (including network-accessible modifications) must be released under the same license with source available. See the AGPL FAQ at <https://www.gnu.org/licenses/agpl-3.0.html> for specifics.
