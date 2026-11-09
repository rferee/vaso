import {
	Component,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	TFile,
	setIcon,
	setTooltip,
} from "obsidian";
import type { Editor, WorkspaceLeaf } from "obsidian";
import type VasoPlugin from "./main";
import type { SearchResult } from "./types";
import { PROVIDER_LABELS } from "./types";
import { chatStreamWithStatus } from "./llm";
import type { StreamPhase } from "./llm";
import { LLMCache } from "./llm-cache";
import { ContextPipeline } from "./context-pipeline";
import type { PipelineRun } from "./context-pipeline";
import type { ThreeLayerResult } from "./search";
import { hasIndexScope, indexMismatch } from "./indexer";
import { errorMessage, isAbortError } from "./errors";
import { getLogger } from "./logger";

export const CONTEXT_VIEW_TYPE = "vaso-context";

type Trigger = "edit" | "switch" | "manual";

/** Streaming re-renders are throttled; full Markdown renders per token are slow on phones. */
const STREAM_RENDER_MS = 120;

const LAYER_INFO = {
	l0: { label: "L0", title: "Matched to the paragraph you're editing" },
	l1: { label: "L1", title: "Matched to the whole note (full page sent)" },
	l2: { label: "L2", title: "Broad context (excerpt sent)" },
} as const;

export class VasoContextView extends ItemView {
	plugin: VasoPlugin;

	private statusEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private refreshBtn!: HTMLElement;
	private stopBtn!: HTMLElement;

	private llmCache: LLMCache;
	private pipeline: ContextPipeline;

	/** The note the panel follows. Kept when focus moves to the panel itself. */
	private file: TFile | null = null;
	private lastInputKey = "";
	private debounceTimer: number | null = null;
	private abortController: AbortController | null = null;
	/** A refresh is running; new triggers wait for it instead of cancelling it. */
	private busy = false;
	/** A trigger arrived while busy: run once more afterwards. */
	private rerun: Trigger | null = null;
	private closed = false;

	/** Raw Markdown of the answer on screen (for Copy). */
	private answerText = "";
	private tokensText = "—";
	private activityText = "—";

	/** Bumped per synthesis layout and per slot render, so late async renders are dropped. */
	private renderSeq = 0;
	private slotSeq = new Map<string, number>();
	private markdownParts = new Map<string, Component>();
	private streamTimer: number | null = null;
	private streamPending: { answer?: string; reasoning?: string } = {};

	constructor(leaf: WorkspaceLeaf, plugin: VasoPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.llmCache = new LLMCache(this.app.vault.adapter, plugin.manifest.dir ?? "");
		this.pipeline = new ContextPipeline(this.app, this.llmCache, () => this.plugin.settings);
	}

	getViewType(): string {
		return CONTEXT_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Vaso";
	}
	getIcon(): string {
		return "book-open";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("vaso-container");

		const header = root.createDiv("vaso-header");
		header.createDiv({ cls: "vaso-title", text: "Lore context" });
		const actions = header.createDiv("vaso-header-actions");
		this.refreshBtn = this.iconButton(actions, "refresh-cw", "Refresh context", () => this.refreshNow());
		this.stopBtn = this.iconButton(actions, "square", "Stop the response", () => this.stopInFlight());

		this.statusEl = root.createDiv("vaso-status");
		this.bodyEl = root.createDiv("vaso-body");
		this.bodyEl.createDiv({ cls: "vaso-placeholder", text: "Start writing to see relevant lore." });

		// Internal links in rendered answers should navigate like in a note.
		this.bodyEl.on("click", "a.internal-link", (evt, a) => {
			evt.preventDefault();
			const target = a.getAttr("data-href") ?? a.getText();
			void this.app.workspace.openLinkText(target, this.file?.path ?? "", evt.ctrlKey || evt.metaKey);
		});

		await this.llmCache.load();

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView && view.file && view.file !== this.file) {
					this.file = view.file;
					this.lastInputKey = "";
					this.trigger("switch");
				}
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				if (info.file) this.file = info.file;
				this.trigger("edit");
			}),
		);

		this.file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? this.app.workspace.getActiveFile();
		this.updateButtons();
		this.renderStatus();
		if (this.file) this.trigger("switch");
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.rerun = null;
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		if (this.streamTimer !== null) window.clearTimeout(this.streamTimer);
		this.abortController?.abort();
		await this.llmCache.save();
	}

	// ── Triggers ─────────────────────────────────────────────

	/** The index just became usable: run again (cached answers still apply). */
	indexReady(): void {
		this.lastInputKey = "";
		this.trigger("switch");
	}

	/** Refresh now, ignoring the response cache (header button, command). */
	refreshNow(): void {
		this.trigger("manual");
	}

	private trigger(mode: Trigger): void {
		if (this.closed) return;
		if (this.busy) {
			// Let the in-flight response finish (⏹ cancels it), then catch up once.
			if (this.rerun !== "manual") this.rerun = mode;
			return;
		}
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		const s = this.plugin.settings;
		const delay = mode === "manual" ? 50 : mode === "switch" ? s.noteSwitchDebounceMs : s.debounceMs;
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			void this.refresh(mode === "manual");
		}, delay);
	}

	private stopInFlight(): void {
		if (!this.busy) return;
		this.rerun = null;
		this.abortController?.abort();
	}

	// ── Refresh ──────────────────────────────────────────────

	private async refresh(force: boolean): Promise<void> {
		if (this.closed || this.busy || !this.plugin.settings.contextPanelEnabled) return;
		const file = this.file;
		if (!file) {
			this.setActivity("Open a note to see its lore context.");
			return;
		}

		this.busy = true;
		this.rerun = null;
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		this.updateButtons();

		try {
			const prepared = await this.pipeline.prepare(
				file,
				this.editorFor(file),
				this.plugin.store.index,
				{ force, signal, prevInputKey: this.lastInputKey },
				{
					embeddingParagraph: () => this.setActivity("Embedding paragraph…"),
					embeddingNote: () => this.setActivity("Embedding note…"),
					searching: () => this.setActivity("Searching the vault…"),
					readingPages: () => this.setActivity("Reading source pages…"),
				},
			);
			this.lastInputKey = prepared.inputKey;
			await this.show(file, prepared.run, signal);
		} catch (err) {
			if (signal.aborted || isAbortError(err)) {
				this.setActivity("Stopped");
			} else {
				getLogger().error("context", "Refresh failed", err);
				this.setActivity(`Error: ${errorMessage(err)}`);
				// Allow a retry on the next edit even if the text didn't change.
				this.lastInputKey = "";
			}
		} finally {
			this.busy = false;
			this.abortController = null;
			this.updateButtons();
			const again = this.rerun;
			this.rerun = null;
			if (again) this.trigger(again);
		}
	}

	private async show(file: TFile, run: PipelineRun, signal: AbortSignal): Promise<void> {
		switch (run.kind) {
			case "skipped":
				return;
			case "tooShort":
				this.setActivity("Write a bit more to get context.");
				return;
			case "noIndex":
				this.setActivity("The index is empty.");
				this.renderStatus();
				return;
			case "indexProblem":
				this.setActivity("The index needs a rebuild.");
				this.plugin.store.reportMismatch(run.message);
				return;
			case "noMatches":
				this.setActivity("No relevant lore found.");
				this.renderPlaceholder("No relevant lore found for this note.");
				return;
			case "cached":
				this.setActivity("Cached answer (sources unchanged)");
				this.setTokens("—");
				this.renderSynthesis(run.sources);
				this.setAnswer(run.response, true);
				return;
			case "ready":
				await this.stream(file, run, signal);
				return;
		}
	}

	private async stream(
		file: TFile,
		run: Extract<PipelineRun, { kind: "ready" }>,
		signal: AbortSignal,
	): Promise<void> {
		const log = getLogger();
		if (log.debugEnabled) {
			for (const m of run.messages) log.debug("context", `[${m.role}] (${m.content.length} chars):\n${m.content}`);
		}

		const firstEp = this.plugin.settings.inferenceEndpoints[0];
		let tag = firstEp ? PROVIDER_LABELS[firstEp.providerType] : "LLM";
		const promptTokens = Math.round(run.messages.reduce((n, m) => n + m.content.length, 0) / 4);
		let chunks = 0;
		let startedAt = 0;
		let answer = "";

		const phaseText: Record<StreamPhase, string> = {
			loading: "Loading model…",
			processing: "Processing prompt…",
			reasoning: "Thinking…",
			generating: "Writing…",
			done: "Done",
		};

		this.renderSynthesis(run.sources);
		this.setAnswer("", false);
		this.setActivity("Connecting…");
		this.setTokens(`~${promptTokens} in · waiting…`);

		try {
			const result = await chatStreamWithStatus(
				run.messages,
				this.plugin.settings,
				{
					onStatus: (phase, detail) => {
						if (phase === "done") return;
						if (phase === "generating" && !startedAt) startedAt = Date.now();
						this.setActivity(`[${tag}] ${detail ?? phaseText[phase]}`);
					},
					onChunk: (text) => {
						if (!startedAt) {
							startedAt = Date.now();
							this.setActivity(`[${tag}] ${phaseText.generating}`);
						}
						chunks++;
						answer = text;
						this.queueStream({ answer: text });
						const secs = (Date.now() - startedAt) / 1000;
						const rate = secs > 0.3 && chunks > 2 ? ` · ${(chunks / secs).toFixed(1)} t/s` : "";
						this.setTokens(`~${promptTokens} in · ${chunks} out${rate}`);
					},
					onReasoning: (text) => this.queueStream({ reasoning: text }),
				},
				signal,
			);

			tag = PROVIDER_LABELS[result.endpoint.providerType];
			this.flushStream();
			this.setAnswer(result.text, true);
			const secs = startedAt ? (Date.now() - startedAt) / 1000 : 0;
			const out = result.stats?.responseTokens ?? chunks;
			const inTok = result.stats ? `${result.stats.promptTokens}` : `~${promptTokens}`;
			this.setTokens(`${inTok} in · ${out} out${secs > 0 && out > 0 ? ` · ${(out / secs).toFixed(1)} t/s` : ""}`);
			this.setActivity(`[${tag}] Done`);

			if (result.text) this.pipeline.storeResponse(file.path, run.cacheKey, result.text);
		} catch (err) {
			this.flushStream();
			if (signal.aborted || isAbortError(err)) {
				// Keep whatever arrived before ⏹.
				this.setAnswer(answer, true, answer ? undefined : "Stopped before any text arrived.");
				this.setActivity("Stopped");
				return;
			}
			log.warn("context", "LLM request failed", err);
			this.setAnswer("", true, `LLM unavailable — ${errorMessage(err)}. The matched sources are below.`);
			this.setTokens("—");
			this.setActivity("LLM unavailable");
		}
	}

	// ── Status ───────────────────────────────────────────────

	/** Index state, problems and quick actions. Called by the plugin on index changes. */
	renderStatus(): void {
		if (!this.statusEl) return;
		const store = this.plugin.store;
		const settings = this.plugin.settings;
		this.statusEl.empty();

		const row = (label: string, value: string, cls = "") => {
			const r = this.statusEl.createDiv("vaso-status-row " + cls);
			r.createSpan({ cls: "vaso-status-label", text: label });
			return r.createSpan({ cls: "vaso-status-value", text: value });
		};

		const indexRow = this.statusEl.createDiv("vaso-status-row");
		const dot = indexRow.createSpan("vaso-dot");
		indexRow.createSpan({ cls: "vaso-status-label", text: "Index" });
		const value = indexRow.createSpan("vaso-status-value");

		const progress = store.progress;
		const configMismatch = store.index ? indexMismatch(store.index, settings) : null;
		let problem: string | null = store.problem;
		let action: "rebuild" | "update" | null = store.needsRebuild ? "rebuild" : problem ? "update" : null;
		if (!hasIndexScope(settings)) {
			problem = "No folders are selected for indexing yet. Choose them in Settings → Vaso → Index.";
			action = null;
		} else if (configMismatch) {
			problem = `${configMismatch} Rebuild the index.`;
			action = "rebuild";
		} else if (store.chunkCount === 0 && !problem) {
			problem = "The index hasn't been built yet.";
			action = "update";
		}

		if (progress) {
			dot.addClass("is-busy");
			value.setText(progress.total > 0 ? `${progress.label} ${progress.done}/${progress.total}` : `${progress.label}…`);
		} else if (store.chunkCount > 0) {
			dot.addClass(problem ? "is-warn" : "is-ok");
			value.setText(`${store.chunkCount} chunks · ${store.pageCount} pages`);
			if (store.index) setTooltip(value, `Last updated ${new Date(store.index.builtAt).toLocaleString()}`);
		} else {
			dot.addClass(problem ? "is-warn" : "is-off");
			value.setText("not built");
		}

		if (problem && !progress) {
			const box = this.statusEl.createDiv("vaso-status-problem");
			box.createSpan({ text: problem });
			if (action) {
				const btn = box.createEl("button", {
					cls: "mod-cta",
					text: action === "rebuild" ? "Rebuild index" : store.chunkCount === 0 ? "Build index" : "Retry",
				});
				btn.addEventListener("click", () => void (action === "rebuild" ? store.rebuild() : store.update(true)));
			}
		}

		row("Tokens", this.tokensText, "vaso-status-tokens");
		row("Status", this.activityText, "vaso-status-activity");
	}

	private setActivity(text: string): void {
		this.activityText = text;
		const el = this.statusEl?.querySelector(".vaso-status-activity .vaso-status-value");
		if (el) el.textContent = text;
	}

	private setTokens(text: string): void {
		this.tokensText = text;
		const el = this.statusEl?.querySelector(".vaso-status-tokens .vaso-status-value");
		if (el) el.textContent = text;
	}

	private updateButtons(): void {
		this.refreshBtn?.toggleClass("is-disabled", this.busy);
		this.stopBtn?.toggleClass("is-disabled", !this.busy);
		this.stopBtn?.toggleClass("is-active", this.busy);
	}

	// ── Body rendering ───────────────────────────────────────

	private renderPlaceholder(text: string): void {
		this.clearMarkdown();
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "vaso-placeholder", text });
	}

	/** Lay out the answer area and the source list. */
	private renderSynthesis(sources: ThreeLayerResult): void {
		this.clearMarkdown();
		this.renderSeq++;
		this.bodyEl.empty();

		const synth = this.bodyEl.createDiv("vaso-synthesis");
		const head = synth.createDiv("vaso-section-head");
		head.createDiv({ cls: "vaso-section-title", text: "Relevant facts" });
		this.iconButton(head, "copy", "Copy answer", () => {
			if (!this.answerText) return;
			void navigator.clipboard.writeText(this.answerText).then(() => new Notice("Copied"));
		});
		synth.createDiv("vaso-reasoning");
		synth.createDiv("vaso-answer");

		const all = [
			...sources.l0.map((r) => [r, "l0"] as const),
			...sources.l1.map((r) => [r, "l1"] as const),
			...sources.l2.map((r) => [r, "l2"] as const),
		];
		if (all.length === 0) return;
		const list = this.bodyEl.createDiv("vaso-sources");
		list.createDiv({ cls: "vaso-section-title", text: "Sources" });
		for (const [r, layer] of all) this.renderSourceCard(list, r, layer);
	}

	/**
	 * Show answer text. `final` renders immediately; `note` replaces an empty
	 * answer with a muted message.
	 */
	private setAnswer(text: string, final: boolean, note?: string): void {
		const el = this.bodyEl.querySelector<HTMLElement>(".vaso-answer");
		if (!el) return;
		this.answerText = text;
		if (!text) {
			this.clearMarkdown("answer");
			el.empty();
			el.createDiv({ cls: "vaso-muted", text: note ?? (final ? "No answer." : "Waiting for the model…") });
			return;
		}
		void this.renderMarkdown("answer", el, text);
	}

	private setReasoning(text: string): void {
		const wrap = this.bodyEl.querySelector<HTMLElement>(".vaso-reasoning");
		if (!wrap || !text) return;
		let details = wrap.querySelector("details");
		if (!details) {
			details = wrap.createEl("details");
			details.createEl("summary", { text: "Thinking" });
			details.createDiv("vaso-reasoning-body");
		}
		const body = details.querySelector<HTMLElement>(".vaso-reasoning-body");
		// Only re-render while it's open; the summary is enough when collapsed.
		if (body && details.open) void this.renderMarkdown("reasoning", body, text);
		else if (body) body.dataset.pending = text;
		details.ontoggle = () => {
			const pending = body?.dataset.pending;
			if (details?.open && body && pending) {
				delete body.dataset.pending;
				void this.renderMarkdown("reasoning", body, pending);
			}
		};
	}

	private queueStream(part: { answer?: string; reasoning?: string }): void {
		Object.assign(this.streamPending, part);
		if (this.streamTimer !== null) return;
		this.streamTimer = window.setTimeout(() => this.flushStream(), STREAM_RENDER_MS);
	}

	private flushStream(): void {
		if (this.streamTimer !== null) window.clearTimeout(this.streamTimer);
		this.streamTimer = null;
		const { answer, reasoning } = this.streamPending;
		this.streamPending = {};
		if (reasoning !== undefined) this.setReasoning(reasoning);
		if (answer !== undefined) this.setAnswer(answer, false);
	}

	/** Render Markdown into `el`, owning one child Component per slot so old renders unload. */
	private async renderMarkdown(slot: string, el: HTMLElement, markdown: string): Promise<void> {
		const seq = this.renderSeq;
		const n = (this.slotSeq.get(slot) ?? 0) + 1;
		this.slotSeq.set(slot, n);
		const component = this.addChild(new Component());
		const fresh = createDiv();
		await MarkdownRenderer.render(this.app, markdown, fresh, this.file?.path ?? "", component);
		if (seq !== this.renderSeq || this.slotSeq.get(slot) !== n || !el.isConnected) {
			this.removeChild(component);
			return;
		}
		el.replaceChildren(...Array.from(fresh.childNodes));
		const old = this.markdownParts.get(slot);
		if (old) this.removeChild(old);
		this.markdownParts.set(slot, component);
	}

	private clearMarkdown(slot?: string): void {
		for (const [key, c] of this.markdownParts) {
			if (slot && key !== slot) continue;
			this.removeChild(c);
			this.markdownParts.delete(key);
		}
	}

	private renderSourceCard(parent: HTMLElement, result: SearchResult, layer: keyof typeof LAYER_INFO): void {
		const card = parent.createDiv("vaso-source");
		const head = card.createDiv("vaso-source-head");

		const name = head.createEl("a", { cls: "vaso-source-name", text: result.chunk.pageName, href: "#" });
		name.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const file = this.app.vault.getAbstractFileByPath(result.chunk.filePath);
			if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
		});

		const badge = head.createSpan({ cls: `vaso-badge vaso-badge-${layer}`, text: LAYER_INFO[layer].label });
		setTooltip(badge, LAYER_INFO[layer].title);
		head.createSpan({ cls: "vaso-source-sim", text: `${(result.similarity * 100).toFixed(0)}%` });
		const chevron = head.createSpan("vaso-source-chevron");
		setIcon(chevron, "chevron-down");

		const preview = card.createDiv({ cls: "vaso-source-preview vaso-hidden" });
		preview.setText(result.chunk.text.length > 280 ? result.chunk.text.slice(0, 280) + "…" : result.chunk.text);
		head.addEventListener("click", () => {
			const open = preview.hasClass("vaso-hidden");
			preview.toggleClass("vaso-hidden", !open);
			card.toggleClass("is-open", open);
		});
	}

	// ── Helpers ──────────────────────────────────────────────

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const btn = parent.createDiv({ cls: "clickable-icon vaso-icon-btn", attr: { "aria-label": label, role: "button" } });
		setIcon(btn, icon);
		btn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			onClick();
		});
		return btn;
	}

	/** Editor of an open Markdown view showing `file`, if any (focus may be in the panel). */
	private editorFor(file: TFile): Editor | undefined {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file === file) return active.editor;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file === file) return view.editor;
		}
		return undefined;
	}
}
