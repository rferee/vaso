import { App, PluginSettingTab, Setting } from "obsidian";
import type VasoPlugin from "../main";
import type { ModelEntry, ModelInfo } from "../llm";
import { getLogger } from "../logger";
import type { SettingsContext } from "./shared";
import { renderEndpointSection } from "./endpoint-card";

export class VasoSettingTab extends PluginSettingTab {
	plugin: VasoPlugin;

	/** Cached model lists per URL — survives re-renders within the open tab. */
	private modelCache = new Map<string, ModelEntry[]>();
	/** Cached model info per "url::model" key. */
	private modelInfoCache = new Map<string, ModelInfo>();

	constructor(app: App, plugin: VasoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private buildContext(): SettingsContext {
		return {
			plugin: this.plugin,
			modelCache: this.modelCache,
			modelInfoCache: this.modelInfoCache,
			refresh: () => this.display(),
		};
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const ctx = this.buildContext();

		// ── Endpoint sections ───────────────────────────────
		renderEndpointSection(
			ctx,
			containerEl,
			"Embedding Endpoints",
			"Tried in order until one responds. Used for generating vector embeddings.",
			"embedding",
		);
		renderEndpointSection(
			ctx,
			containerEl,
			"Inference Endpoints",
			"Tried in order until one responds. Used for LLM chat synthesis.",
			"inference",
		);

		// ── System Prompt ───────────────────────────────────
		containerEl.createEl("h3", { text: "System prompt" });

		new Setting(containerEl)
			.setName("LLM system prompt")
			.setDesc(
				"Sent as the system message when synthesizing lore context. Use this to control the style, format, and behaviour of the output.",
			)
			.addTextArea((text) => {
				text.setPlaceholder("You are a lore assistant…")
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 8;
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "var(--font-monospace)";
				text.inputEl.style.fontSize = "0.85em";
				return text;
			});

		new Setting(containerEl)
			.setName("Writing context (words)")
			.setDesc(
				"Number of words from the current note to send as writing context. 0 = send the full file.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 2000, 50)
					.setValue(this.plugin.settings.contextWords)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.contextWords = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Strip frontmatter")
			.setDesc(
				"Remove YAML frontmatter from the current note and source pages before sending to the LLM.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stripFrontmatter)
					.onChange(async (value) => {
						this.plugin.settings.stripFrontmatter = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Strip callouts")
			.setDesc(
				"Remove Obsidian callout blocks (> [!type]) from content before sending to the LLM, except whitelisted types.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.stripCallouts)
					.onChange(async (value) => {
						this.plugin.settings.stripCallouts = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Callout whitelist")
			.setDesc(
				'Callout types to keep when stripping. One per line, case-insensitive (e.g. "example").',
			)
			.addTextArea((text) => {
				text.setPlaceholder("example")
					.setValue(this.plugin.settings.calloutWhitelist.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.calloutWhitelist = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 3;
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "var(--font-monospace)";
				text.inputEl.style.fontSize = "0.85em";
				return text;
			});

		// ── Retrieval Tuning ────────────────────────────────
		containerEl.createEl("h3", { text: "Retrieval tuning" });

		new Setting(containerEl)
			.setName("L0 — paragraph focus (chunks)")
			.setDesc(
				"Number of chunks most similar to the current paragraph. Only active when the cursor position is available. Set to 0 to disable.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 10, 1)
					.setValue(this.plugin.settings.l0Chunks)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.l0Chunks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("L0 include neighbor paragraphs")
			.setDesc(
				"When on, the L0 query embeds the cursor paragraph plus one before and one after. When off, only the cursor paragraph is embedded.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.l0IncludeNeighborParagraphs)
					.onChange(async (value) => {
						this.plugin.settings.l0IncludeNeighborParagraphs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("L0 match depth")
			.setDesc(
				"How much content to include per L0 match. Chunk = matched chunk only. Nearby = matched chunk ± surrounding chunks. Page = full source page.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						chunk: "Chunk only",
						nearby: "Nearby chunks",
						page: "Full page",
					})
					.setValue(this.plugin.settings.l0Depth)
					.onChange(async (value) => {
						this.plugin.settings.l0Depth = value as "chunk" | "nearby" | "page";
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.l0Depth === "nearby") {
			new Setting(containerEl)
				.setName("L0 nearby radius")
				.setDesc(
					"How many chunks before and after each L0 match to include.",
				)
				.addSlider((slider) =>
					slider
						.setLimits(1, 5, 1)
						.setValue(this.plugin.settings.l0NearbyRadius)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.l0NearbyRadius = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("L1 — whole-note relevance (full pages)")
			.setDesc(
				"Number of top-matching pages (by max similarity across all note chunks) whose full content is sent to the LLM.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 10, 1)
					.setValue(this.plugin.settings.l1Chunks)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.l1Chunks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("L2 — broad context (chunks only)")
			.setDesc(
				"Number of additional chunks from pages not already in L0 or L1.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 15, 1)
					.setValue(this.plugin.settings.l2Chunks)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.l2Chunks = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("L1 max page size (words)")
			.setDesc("Truncate full pages beyond this word count.")
			.addSlider((slider) =>
				slider
					.setLimits(200, 3000, 100)
					.setValue(this.plugin.settings.l1MaxPageWords)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.l1MaxPageWords = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Chunking ────────────────────────────────────────
		containerEl.createEl("h3", { text: "Chunking" });

		new Setting(containerEl)
			.setName("Chunk size (words)")
			.setDesc("Target number of words per chunk when indexing.")
			.addSlider((slider) =>
				slider
					.setLimits(100, 1000, 50)
					.setValue(this.plugin.settings.chunkSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Chunk overlap (words)")
			.setDesc("Overlap between adjacent chunks for continuity.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 200, 10)
					.setValue(this.plugin.settings.chunkOverlap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkOverlap = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Index Scope ─────────────────────────────────────
		containerEl.createEl("h3", { text: "Index scope" });

		new Setting(containerEl)
			.setName("Index root files")
			.setDesc(
				"Include files in the vault root (not inside any subdirectory).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.indexRoot)
					.onChange(async (value) => {
						this.plugin.settings.indexRoot = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Indexed directories")
			.setDesc(
				"Only files inside these directories will be indexed. One directory per line. Rebuild index after changing.",
			)
			.addTextArea((text) => {
				text.setPlaceholder("Geography & Regions\nReligion & Lore")
					.setValue(this.plugin.settings.indexedDirectories.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.indexedDirectories = value
							.split("\n")
							.map((d) => d.trim())
							.filter((d) => d.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = "100%";
				text.inputEl.style.fontFamily = "var(--font-monospace)";
				text.inputEl.style.fontSize = "0.85em";
				return text;
			});

		// ── Behaviour ───────────────────────────────────────
		containerEl.createEl("h3", { text: "Behaviour" });

		new Setting(containerEl)
			.setName("Debounce (ms)")
			.setDesc(
				"How long to wait after you stop typing before refreshing context.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(500, 10000, 250)
					.setValue(this.plugin.settings.debounceMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.debounceMs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Note switch debounce (ms)")
			.setDesc(
				"How long to wait after switching notes before refreshing context. Prevents rapid-fire LLM calls when clicking through notes.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(500, 15000, 500)
					.setValue(this.plugin.settings.noteSwitchDebounceMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.noteSwitchDebounceMs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Index auto-update debounce (ms)")
			.setDesc(
				"How long to wait after a file changes before re-indexing it. Set to 0 to disable auto-updates (manual rebuild only).",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 30000, 1000)
					.setValue(this.plugin.settings.indexDebounceMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.indexDebounceMs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable context panel")
			.setDesc("Show the AI-powered lore context sidebar.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.contextPanelEnabled)
					.onChange(async (value) => {
						this.plugin.settings.contextPanelEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── Debug ───────────────────────────────────────────
		containerEl.createEl("h3", { text: "Debug" });

		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc(
				"Write verbose debug logs to vaso-debug.log in the plugin folder. " +
				"Useful for diagnosing search quality, embedding, and LLM issues.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLogging)
					.onChange(async (value) => {
						this.plugin.settings.debugLogging = value;
						await this.plugin.saveSettings();
						getLogger().updateConfig({ enabled: value });
					}),
			);

		new Setting(containerEl)
			.setName("Max log file size (MB)")
			.setDesc(
				"When the log file exceeds this size, it is deleted and a fresh one starts.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.debugLogMaxSizeMB)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.debugLogMaxSizeMB = value;
						await this.plugin.saveSettings();
						getLogger().updateConfig({
							maxFileSizeBytes: value * 1024 * 1024,
						});
					}),
			);
	}
}
