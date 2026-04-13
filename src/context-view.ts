import { ItemView, WorkspaceLeaf, TFile, MarkdownRenderer } from "obsidian";
import type VasoPlugin from "./main";
import type { SearchResult } from "./types";
import { chatStreamWithStatus, providerLabel } from "./llm";
import type { ChatStats, StreamPhase } from "./llm";
import { LLMCache } from "./llm-cache";
import { ContextPipeline } from "./context-pipeline";
import type { PipelineRun } from "./context-pipeline";
import { getLogger } from "./logger";

export const CONTEXT_VIEW_TYPE = "vaso-context";

export class VasoContextView extends ItemView {
	plugin: VasoPlugin;
	private contentEl_: HTMLElement | null = null;
	private statusBarEl: HTMLElement | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastQueryText = "";
	private abortController: AbortController | null = null;

	/** Header buttons — references kept so we can toggle their enabled state. */
	private refreshBtn: HTMLElement | null = null;
	private stopBtn: HTMLElement | null = null;
	/**
	 * Lock — when true, a refresh (embedding + search + LLM stream) is in
	 * progress. New triggers are skipped until the current one finishes or is
	 * stopped. Lets a slow response complete instead of being cancelled and
	 * restarted on every keystroke.
	 */
	private busy = false;

	/** LLM response cache (persisted to disk). */
	private llmCache: LLMCache | null = null;
	/** Wraps embedding/search/context-build off the view. */
	private pipeline: ContextPipeline | null = null;

	/** Last LLM token usage stats (displayed in status bar). */
	private lastStats: ChatStats | null = null;
	/** Last TPS measurement (displayed in status bar). */
	private lastTps: string | null = null;
	/** Last activity text (persisted across status bar re-renders). */
	private lastActivity = "—";

	constructor(leaf: WorkspaceLeaf, plugin: VasoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return CONTEXT_VIEW_TYPE; }
	getDisplayText(): string { return "Vaso"; }
	getIcon(): string { return "book-open"; }

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.empty();
		container.addClass("vaso-container");

		const header = container.createDiv("vaso-header");
		header.createEl("h4", { text: "Vaso" });

		const headerBtns = header.createDiv("vaso-header-btns");
		this.refreshBtn = headerBtns.createEl("span", {
			cls: "vaso-header-btn",
			text: "↻",
			title: "Refresh context",
		});
		this.refreshBtn.addEventListener("click", () => this.triggerRefresh("manual"));

		this.stopBtn = headerBtns.createEl("span", {
			cls: "vaso-header-btn vaso-header-btn-stop",
			text: "⏹",
			title: "Stop the in-flight LLM response",
		});
		this.stopBtn.addEventListener("click", () => this.stopInFlight());
		this.updateActionButtons();

		this.statusBarEl = container.createDiv("vaso-statusbar");
		this.renderStatusBar();

		this.contentEl_ = container.createDiv("vaso-content");
		this.contentEl_.createEl("p", {
			cls: "vaso-placeholder",
			text: "Start writing to see relevant lore…",
		});

		this.llmCache = new LLMCache(this.app.vault.adapter, this.plugin.manifest.dir ?? "");
		await this.llmCache.load();
		this.pipeline = new ContextPipeline(
			this.app,
			this.llmCache,
			() => this.plugin.settings,
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.lastQueryText = "";
				this.triggerRefresh("switch");
			})
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				this.triggerRefresh("edit");
			})
		);
	}

	async onClose(): Promise<void> {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.abortController?.abort();
		await this.llmCache?.save();
	}

	// ── Refresh triggers ─────────────────────────────────────

	private triggerRefresh(mode: "edit" | "switch" | "manual") {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);

		let delay: number;
		switch (mode) {
			case "manual": delay = 100; break;
			case "switch": delay = this.plugin.settings.noteSwitchDebounceMs; break;
			default: delay = this.plugin.settings.debounceMs; break;
		}

		const bustCache = mode === "manual";
		this.debounceTimer = setTimeout(() => {
			// Lock — let the in-flight request finish; user can hit ⏹ to cancel.
			if (this.busy) return;
			this.refresh(bustCache).catch((err) => {
				getLogger().error("context", "Refresh error", err);
			});
		}, delay);
	}

	/** Abort the in-flight request (called by the ⏹ button). */
	private stopInFlight() {
		if (!this.busy) return;
		this.abortController?.abort();
		this.setActivity("Stopped");
	}

	/** Toggle button enabled/active classes based on `busy`. */
	private updateActionButtons() {
		this.refreshBtn?.toggleClass("vaso-header-btn-disabled", this.busy);
		this.stopBtn?.toggleClass("vaso-header-btn-disabled", !this.busy);
		this.stopBtn?.toggleClass("vaso-header-btn-active", this.busy);
	}

	// ── Status bar ───────────────────────────────────────────

	renderStatusBar(): void {
		if (!this.statusBarEl) return;
		this.statusBarEl.empty();

		const idx = this.plugin.vaultIndex;
		const chunks = idx ? idx.chunks.length : 0;
		const pages = idx ? new Set(idx.chunks.map((c) => c.filePath)).size : 0;
		const builtAt = idx?.builtAt ? new Date(idx.builtAt).toLocaleTimeString() : "never";

		const indexRow = this.statusBarEl.createDiv("vaso-sb-row");
		const dot = indexRow.createEl("span", { cls: "vaso-sb-dot" });
		if (this.plugin.indexing) dot.addClass("vaso-sb-dot-busy");
		else if (chunks > 0) dot.addClass("vaso-sb-dot-ok");
		else dot.addClass("vaso-sb-dot-off");

		indexRow.createEl("span", { cls: "vaso-sb-label", text: "Index" });
		indexRow.createEl("span", {
			cls: "vaso-sb-value",
			text: this.plugin.indexing ? "building…" : chunks > 0 ? `${chunks} chunks · ${pages} pages` : "not built",
		});

		if (chunks > 0 && !this.plugin.indexing) {
			const builtRow = this.statusBarEl.createDiv("vaso-sb-row");
			builtRow.createEl("span", { cls: "vaso-sb-dot vaso-sb-dot-spacer" });
			builtRow.createEl("span", { cls: "vaso-sb-label", text: "Updated" });
			builtRow.createEl("span", { cls: "vaso-sb-value", text: builtAt });
		}

		const tokRow = this.statusBarEl.createDiv("vaso-sb-row");
		tokRow.createEl("span", { cls: "vaso-sb-dot vaso-sb-dot-spacer" });
		tokRow.createEl("span", { cls: "vaso-sb-label", text: "Tokens" });
		let tokText = "—";
		if (this.lastStats) {
			tokText = `${this.lastStats.promptTokens} in · ${this.lastStats.responseTokens} out`;
			if (this.lastTps) {
				tokText += ` · ${this.lastTps}`;
			} else if (this.lastStats.totalDurationMs > 0) {
				tokText += ` · ${(this.lastStats.totalDurationMs / 1000).toFixed(1)}s`;
			}
		}
		tokRow.createEl("span", {
			cls: "vaso-sb-value vaso-sb-tokens-text",
			text: tokText,
		});

		const actRow = this.statusBarEl.createDiv("vaso-sb-row vaso-sb-activity");
		actRow.createEl("span", { cls: "vaso-sb-dot vaso-sb-dot-spacer" });
		actRow.createEl("span", { cls: "vaso-sb-label", text: "Last action" });
		actRow.createEl("span", { cls: "vaso-sb-value vaso-sb-activity-text", text: this.lastActivity });
	}

	private setActivity(text: string) {
		this.lastActivity = text;
		const el = this.statusBarEl?.querySelector(".vaso-sb-activity-text");
		if (el) el.textContent = text;
	}

	private setTokensText(text: string) {
		const el = this.statusBarEl?.querySelector(".vaso-sb-tokens-text");
		if (el) el.textContent = text;
	}

	// ── Main refresh ─────────────────────────────────────────

	private async refresh(force = false): Promise<void> {
		if (!this.plugin.settings.contextPanelEnabled) return;
		if (!this.pipeline) return;
		// Lock — `triggerRefresh` already filters, but guard direct callers too.
		if (this.busy) return;

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile || !(activeFile instanceof TFile)) {
			this.setActivity("—");
			return;
		}

		const editor = this.app.workspace.activeEditor?.editor ?? undefined;

		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		this.busy = true;
		this.updateActionButtons();

		this.lastStats = null;
		this.lastTps = null;
		this.setTokensText("pending…");

		const log = getLogger();
		try {
			let prepared;
			try {
				prepared = await this.pipeline.prepare(
					activeFile,
					editor,
					{ force, signal, prevQueryText: this.lastQueryText },
					{
						embeddingParagraph: () => this.setActivity("Embedding paragraph…"),
						embeddingNote: () => this.setActivity("Embedding note chunks…"),
						searching: () => this.setActivity("Searching vault…"),
						readingPages: () => this.setActivity("Reading source pages…"),
					},
					this.plugin.vaultIndex?.chunks ?? null,
				);
			} catch (err) {
				if (String(err).includes("abort")) return;
				log.error("context", "Pipeline error", err);
				this.setActivity(`Error: ${String(err)}`);
				return;
			}

			this.lastQueryText = prepared.queryText;

			switch (prepared.run.kind) {
				case "tooShort":
					this.setActivity("Write more to get context…");
					return;
				case "noIndex":
					this.setActivity("Index not built yet. Use the command palette to rebuild.");
					return;
				case "skipped":
					return;
				case "noMatches":
					this.setActivity("No relevant matches found.");
					if (this.contentEl_) {
						this.contentEl_.empty();
						this.contentEl_.createEl("p", {
							cls: "vaso-placeholder",
							text: "No relevant lore found for your current writing.",
						});
					}
					return;
				case "cached":
					this.setActivity("Cached");
					this.setTokensText("—");
					this.renderResults(prepared.run.response, prepared.run.sources.l0, prepared.run.sources.l1, prepared.run.sources.l2);
					return;
				case "ready":
					await this.runStreaming(activeFile.path, prepared.run, signal);
					return;
			}
		} finally {
			this.busy = false;
			this.abortController = null;
			this.updateActionButtons();
		}
	}

	// ── LLM streaming ────────────────────────────────────────

	private async runStreaming(
		filePath: string,
		ready: Extract<PipelineRun, { kind: "ready" }>,
		signal: AbortSignal,
	): Promise<void> {
		const log = getLogger();
		const settings = this.plugin.settings;
		const { messages, sources, cacheKey } = ready;
		const { l0, l1, l2 } = sources;

		log.debug("context", "── LLM Prompt ──");
		for (const m of messages) {
			log.debug("context", `[${m.role}] (${m.content.length} chars):\n${m.content}`);
		}
		log.debug("context", "── End Prompt ──");

		this.setActivity("Connecting to LLM…");
		this.prepareStreamingUI(l0, l1, l2);

		let streamTokenCount = 0;
		let generationStartTime = 0;
		const promptCharCount = messages.reduce((n, m) => n + m.content.length, 0);
		const estimatedPromptTokens = Math.round(promptCharCount / 4);
		// Best guess from the first configured endpoint; corrected to the resolved one when the call returns.
		let providerTag = settings.inferenceEndpoints.length > 0
			? providerLabel(settings.inferenceEndpoints[0]!.providerType)
			: "LLM";

		const updateTokensWithTps = () => {
			if (generationStartTime <= 0) return;
			const elapsed = (Date.now() - generationStartTime) / 1000;
			const tps = elapsed > 0.3 && streamTokenCount > 2
				? ` · ${(streamTokenCount / elapsed).toFixed(1)} t/s`
				: "";
			this.setTokensText(`~${estimatedPromptTokens} in · ${streamTokenCount} out${tps}`);
		};

		const statusText = (phase: StreamPhase, detail?: string): string => {
			switch (phase) {
				case "loading":    return detail ?? "Loading model…";
				case "processing": return "Processing prompt…";
				case "reasoning":  return "Thinking…";
				case "generating": return "Generating…";
				case "done":       return "Done";
			}
		};

		this.setTokensText(`~${estimatedPromptTokens} in · streaming…`);
		try {
			const result = await chatStreamWithStatus(messages, settings, {
				onStatus: (phase, detail) => {
					if (phase === "done") return;
					if (phase === "generating" && generationStartTime <= 0) {
						generationStartTime = Date.now();
					}
					this.setActivity(`[${providerTag}] ${statusText(phase, detail)}`);
				},
				onChunk: (accumulated) => {
					if (generationStartTime <= 0) {
						generationStartTime = Date.now();
						this.setActivity(`[${providerTag}] ${statusText("generating")}`);
					}
					streamTokenCount++;
					this.updateStreamingContent(accumulated);
					updateTokensWithTps();
				},
				onReasoning: (accumulated) => {
					this.updateReasoningContent(accumulated);
				},
			}, signal);

			providerTag = providerLabel(result.endpoint.providerType);
			if (result.stats) {
				this.lastStats = result.stats;
				log.info(
					"context",
					`Tokens: ${result.stats.promptTokens} in, ${result.stats.responseTokens} out, ${(result.stats.totalDurationMs / 1000).toFixed(1)}s`,
				);
			}

			const totalElapsed = generationStartTime > 0 ? (Date.now() - generationStartTime) / 1000 : 0;
			const finalTokens = result.stats?.responseTokens ?? streamTokenCount;
			this.lastTps = totalElapsed > 0 && finalTokens > 0
				? `${(finalTokens / totalElapsed).toFixed(1)} t/s`
				: null;

			if (result.text) {
				this.pipeline?.storeResponse(filePath, cacheKey, result.text);
			}
			this.renderStatusBar();
			this.setActivity("Done");
		} catch (err) {
			log.warn("context", "LLM unreachable, showing raw results", err);
			this.renderResults(null, l0, l1, l2);
			this.setTokensText("—");
			this.setActivity("LLM unavailable");
		}
	}

	// ── UI rendering ─────────────────────────────────────────

	/** Render the sources section (shared by streaming prep and final render). */
	private renderSourcesSection(
		parent: HTMLElement,
		l0: SearchResult[],
		l1: SearchResult[],
		l2: SearchResult[]
	) {
		if (l0.length === 0 && l1.length === 0 && l2.length === 0) return;
		const section = parent.createDiv("vaso-sources");
		section.createEl("h5", { text: "Sources" });
		for (const r of l0) this.renderSourceCard(section, r, "l0");
		for (const r of l1) this.renderSourceCard(section, r, "l1");
		for (const r of l2) this.renderSourceCard(section, r, "l2");
	}

	private prepareStreamingUI(l0: SearchResult[], l1: SearchResult[], l2: SearchResult[]) {
		if (!this.contentEl_) return;
		this.contentEl_.empty();

		const synthSection = this.contentEl_.createDiv("vaso-synthesis");
		synthSection.createEl("h5", { text: "Relevant Facts" });
		const synthBody = synthSection.createDiv("vaso-synthesis-body");
		synthBody.addClass("vaso-streaming-body");
		synthBody.createEl("span", { cls: "vaso-muted", text: "Generating…" });

		this.renderSourcesSection(this.contentEl_, l0, l1, l2);
	}

	private updateReasoningContent(accumulated: string) {
		if (!this.contentEl_) return;
		const synthSection = this.contentEl_.querySelector(".vaso-synthesis");
		if (!synthSection) return;

		let wrapper = synthSection.querySelector(".vaso-reasoning") as HTMLElement | null;
		if (!wrapper) {
			// Insert reasoning block before the streaming body so it appears first.
			const streamBody = synthSection.querySelector(".vaso-streaming-body");
			wrapper = createDiv("vaso-reasoning");
			const toggle = wrapper.createEl("span", {
				cls: "vaso-reasoning-toggle",
				text: "Thinking…",
			});
			const body = wrapper.createDiv("vaso-reasoning-body");
			body.addClass("vaso-collapsed");
			toggle.addEventListener("click", () => {
				const open = !body.hasClass("vaso-collapsed");
				body.toggleClass("vaso-collapsed", open);
				toggle.textContent = open ? "Thinking…" : "Thinking ▾";
				toggle.toggleClass("vaso-reasoning-open", !open);
			});
			if (streamBody) {
				synthSection.insertBefore(wrapper, streamBody);
			} else {
				synthSection.appendChild(wrapper);
			}
		}

		const body = wrapper.querySelector(".vaso-reasoning-body") as HTMLElement | null;
		if (body) {
			body.empty();
			MarkdownRenderer.render(this.app, accumulated, body, "", this.plugin);
		}
	}

	private updateStreamingContent(partial: string) {
		const body = this.contentEl_?.querySelector(".vaso-streaming-body");
		if (!body) return;
		body.empty();
		MarkdownRenderer.render(this.app, partial, body as HTMLElement, "", this.plugin);
	}

	private renderResults(
		llmResponse: string | null,
		l0: SearchResult[],
		l1: SearchResult[],
		l2: SearchResult[]
	) {
		if (!this.contentEl_) return;
		this.contentEl_.empty();

		const synthSection = this.contentEl_.createDiv("vaso-synthesis");
		synthSection.createEl("h5", { text: "Relevant Facts" });
		if (llmResponse) {
			const synthBody = synthSection.createDiv("vaso-synthesis-body");
			MarkdownRenderer.render(this.app, llmResponse, synthBody, "", this.plugin);
		} else {
			synthSection.createEl("p", {
				cls: "vaso-muted",
				text: "LLM unavailable — showing raw matches below.",
			});
		}

		this.renderSourcesSection(this.contentEl_, l0, l1, l2);
	}

	private renderSourceCard(
		parent: HTMLElement,
		result: SearchResult,
		layer: "l0" | "l1" | "l2"
	) {
		const card = parent.createDiv("vaso-source-card");
		const headerRow = card.createDiv("vaso-source-header");

		const nameEl = headerRow.createEl("span", {
			cls: "vaso-source-name",
			text: result.chunk.pageName,
		});
		nameEl.addEventListener("click", () => {
			const file = this.app.vault.getAbstractFileByPath(result.chunk.filePath);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf(false).openFile(file);
			}
		});

		const badgeLabels = { l0: "L0", l1: "L1", l2: "L2" };
		const badgeTitles = {
			l0: "Paragraph-focused match (chunk only)",
			l1: "Note-relevant match (full page sent)",
			l2: "Broad context match (chunk only)",
		};
		headerRow.createEl("span", {
			cls: `vaso-source-badge vaso-badge-${layer}`,
			text: badgeLabels[layer],
			title: badgeTitles[layer],
		});

		headerRow.createEl("span", {
			cls: "vaso-source-sim",
			text: `${(result.similarity * 100).toFixed(1)}%`,
		});

		const preview = card.createDiv("vaso-source-preview");
		preview.textContent =
			result.chunk.text.length > 200
				? result.chunk.text.slice(0, 200) + "…"
				: result.chunk.text;
		preview.addClass("vaso-collapsed");

		headerRow.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).classList.contains("vaso-source-name")) return;
			preview.toggleClass("vaso-collapsed", !preview.hasClass("vaso-collapsed"));
		});
	}
}
