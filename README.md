# Vaso

Vaso ("eye" in Suvelinian) is an LLM-powered lore context panel for Obsidian worldbuilding vaults. As you write, Vaso runs a three-layer semantic search across your notes and synthesises the most relevant established facts in a sidebar — so contradictions and forgotten details surface before they make it into the page.

Works on desktop and mobile, with local and remote LLMs (Ollama, LM Studio, OpenRouter, or any OpenAI-compatible endpoint).

---

## What it does

- **Live lore context.** A sidebar view that updates as you type. Three ranked layers of matches feed the LLM:
  - **L0** — chunks most similar to the paragraph under your cursor (optionally including the paragraphs before and after). Depth configurable: matched chunk only, nearby chunks (±N), or the full source page.
  - **L1** — whole-note relevance. The top pages by max similarity across every chunk of the note you're writing, sent in full (truncated at a word limit).
  - **L2** — broad context. Additional chunks from pages not already in L0 or L1.
- **Streaming responses with status phases.** `loading → processing → reasoning → generating → done`. Reasoning tokens (from models that support them) appear in a collapsible "Thinking…" block.
- **Per-file response cache.** The last synthesis for each note is kept on disk and replayed instantly while the retrieved lore and the prompts are unchanged.
- **Incremental indexing.** Edited notes are re-embedded after a pause, and notes changed while Obsidian was closed are picked up at startup. If an endpoint fails, already indexed lore is kept and the failed notes are retried later. Full rebuilds are manual.
- **Endpoint failover.** Configure multiple embedding and inference endpoints; Vaso health-checks them in order and uses the first reachable one. The index remembers its embedding model and asks for a rebuild instead of mixing models.
- **Stop button + lock.** A stop button in the sidebar header aborts the in-flight request. While a response is streaming, edits don't stack new calls — the current one finishes first.
- **Multi-provider.** One settings UI covers Ollama, LM Studio, OpenRouter, and generic OpenAI-compatible servers (vLLM, LocalAI, llama.cpp `--api`, text-generation-webui).
- **Editable prompts.** The system prompt and the message template (with `{{variables}}`) open in a full-size editor.
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

1. **Add endpoints.** Settings → Vaso. Add at least one embedding and one inference endpoint (a local Ollama at `http://localhost:11434` is preset). Use **Browse** to pick a model and **Test** to check the connection.
2. **Choose folders.** Under *Index*, add the folders to index (e.g. `Geography`, `Characters`), and turn on *Notes in the vault root* if you want loose notes.
3. **Build the index.** Press *Update* in the Index group, or run **Vaso: Update vault index** from the command palette.
4. **Open the panel.** Ribbon icon or **Vaso: Open lore context panel**. Start writing in a note; context appears after a short pause.

---

## Mobile

Vaso runs on Obsidian for iOS and Android. A phone can't reach `localhost` on your computer, so add an endpoint with an address the phone can reach: your computer's LAN or Tailscale address, or a hosted provider such as OpenRouter. Endpoints are tried in order, so one list can serve desktop (localhost first) and phone (the next entry).

- **Use the same embedding model on every embedding endpoint.** Vectors from different models can't be compared; Vaso refuses to mix them.
- **HTTPS is the safe choice.** Phones may block plain `http://` to LAN addresses; `tailscale serve` gives a local server a valid certificate.
- **Streaming needs CORS.** Answers stream live when the server allows Obsidian's mobile origin; otherwise Vaso falls back to showing the whole answer at once. Ollama: add `capacitor://localhost` (iOS) to `OLLAMA_ORIGINS` (e.g. `OLLAMA_ORIGINS="capacitor://localhost,http://localhost,https://localhost"`) and restart it. LM Studio: enable CORS in the server settings.

---

## Providers

| Provider         | Chat streaming                          | Reasoning support | Auth         | Model info  |
| ---------------- | --------------------------------------- | ----------------- | ------------ | ----------- |
| **Ollama**       | NDJSON via `/api/chat`                  | `think` field     | none         | `/api/show` |
| **LM Studio**    | Native `/api/v1/chat` (rich SSE events) + `/v1/chat/completions` fallback | `reasoning` setting and events; `reasoning_content` in fallback | optional | `/api/v1/models` |
| **OpenRouter**   | SSE via `/chat/completions`             | `reasoning` effort levels | API key required | via `/models` |
| **OpenAI-compat** (vLLM, LocalAI, llama.cpp, etc.) | SSE via `/v1/chat/completions` | `delta.reasoning_content` / `delta.reasoning` | optional    | —           |

Per-endpoint features exposed in settings:
- **Context window** — model default or a power-of-two size (Ollama `num_ctx`; for LM Studio, Vaso loads the model at that size unless it already is).
- **Keep-alive** (Ollama) — duration string controlling how long the model stays loaded after a request.
- **Temperature** (inference only).
- **Thinking** (Ollama, OpenRouter, LM Studio) — off / on / low / medium / high.
- **Custom parameters** — any JSON-safe key/value, merged into the request body. Prefix a key with `options.` for Ollama's nested `options` object; the prefix is stripped automatically for other providers.
- **Unload all models** (Ollama, LM Studio) — free VRAM from the settings tab.

---

## Commands

| Command                                  | Action                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| **Open lore context panel**              | Reveals the sidebar view (also on the ribbon).           |
| **Refresh lore context**                 | Re-runs the panel, ignoring the cached answer.           |
| **Update vault index (changed files)**   | Embeds new and changed notes, drops deleted ones.        |
| **Rebuild vault index from scratch**     | Re-embeds every in-scope note.                           |

Panel header buttons: refresh (ignores the cache) and stop (keeps the text received so far).

---

## Settings

- **Embedding / inference endpoints** — ordered lists; each row has test, edit, reorder and remove.
- **Index** — status with Update/Rebuild, folders to index, root notes, chunk size and overlap, automatic re-index delay (`0` turns it off).
- **Prompt** — system prompt and message template (full-size editor with variables `{{title}}`, `{{paragraph}}`, `{{writing}}`, `{{l0}}`, `{{l1}}`, `{{l2}}`; `{{#name}}…{{/name}}` keeps text only when the variable has content), writing context length, frontmatter and callout stripping.
- **What gets retrieved** — L0 paragraph matches and their detail, L1 related pages, L2 extra excerpts, word limit per page.
- **Lore panel** — automatic updates and refresh delays.
- **Troubleshooting** — debug log (`<plugin-dir>/vaso-debug.log`, size-limited).

Changing chunking or cleaning settings, or the embedding model, makes the index incompatible; the panel and settings then offer a rebuild.

---

## Data & privacy

- Vaso stores three files inside its plugin directory:
  - `vaso-index.json` — chunk text and embeddings (base64 float32), plus the embedding model and settings they were built with.
  - `vaso-llm-cache.json` — most recent synthesised response per file, keyed by a hash of the prompts and retrieved lore (LRU, capped at 200 entries).
  - `vaso-debug.log` — verbose log when debug logging is enabled.
- **Nothing leaves your machine unless you point Vaso at a remote endpoint** (OpenRouter, a remote Ollama, a Tailscale-reachable LM Studio host, etc.). With local Ollama or local LM Studio the vault contents never leave your device.
- When a remote endpoint is used, the prompt includes: the cleaned current-note excerpt, the configured number of matched chunks, and the LLM system prompt. Full source pages are only included for L1 matches and are truncated at the configured word limit.

---

## Development

```sh
npm install
npm run dev        # watch build (esbuild, inline sourcemap)
npm run build      # typecheck + production build (minified, no sourcemap)
npm test           # unit tests (bundled with esbuild, run with node --test)
```

## Disclaimer

Vaso is built to work with my workflow. While I do accept feature requests and contributions to this project, please contact me in advance or feel free to work the project.

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). See [`LICENSE`](LICENSE) for the full text.

In short: you're free to use, study, modify, and redistribute Vaso, but derivatives (including network-accessible modifications) must be released under the same license with source available. See the AGPL FAQ at <https://www.gnu.org/licenses/agpl-3.0.html> for specifics.
