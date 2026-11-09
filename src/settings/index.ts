import { Platform, PluginSettingTab, Setting, SettingGroup, debounce } from "obsidian";
import type { App, Debouncer } from "obsidian";
import type VasoPlugin from "../main";
import type { EndpointConfig, EndpointKind, L0Depth } from "../types";
import {
	DEFAULT_SYSTEM_PROMPT,
	DEFAULT_USER_PROMPT_TEMPLATE,
	PROVIDER_LABELS,
	createDefaultEndpoint,
} from "../types";
import { checkEndpoint } from "../llm";
import { hasIndexScope, indexMismatch } from "../indexer";
import { TEMPLATE_VARIABLES } from "../prompt-builder";
import { errorMessage } from "../errors";
import { EndpointModal } from "./endpoint-modal";
import { PromptModal } from "./prompt-modal";
import { ConfirmModal, FolderSuggestModal } from "./suggest";

type SectionId = "embedding" | "inference" | "index" | "prompt" | "retrieval" | "panel" | "advanced";

export class VasoSettingTab extends PluginSettingTab {
	plugin: VasoPlugin;
	private sections = new Map<SectionId, { el: HTMLElement; render: (el: HTMLElement) => void }>();
	/** Test results shown under endpoint rows, by endpoint id. */
	private testResults = new Map<string, { ok: boolean; text: string }>();
	private saveSoon: Debouncer<[], void>;
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, plugin: VasoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.saveSoon = debounce(() => void this.plugin.saveSettings(), 400, true);
	}

	private get s() {
		return this.plugin.settings;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("vaso-settings");
		this.sections.clear();

		this.section("embedding", (el) => this.renderEndpoints(el, "embedding"));
		this.section("inference", (el) => this.renderEndpoints(el, "inference"));
		this.section("index", (el) => this.renderIndex(el));
		this.section("prompt", (el) => this.renderPrompt(el));
		this.section("retrieval", (el) => this.renderRetrieval(el));
		this.section("panel", (el) => this.renderPanel(el));
		this.section("advanced", (el) => this.renderAdvanced(el));

		this.unsubscribe?.();
		this.unsubscribe = this.plugin.onIndexChange(() => this.rerender("index"));
	}

	hide(): void {
		this.saveSoon.run();
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private section(id: SectionId, render: (el: HTMLElement) => void): void {
		const el = this.containerEl.createDiv(`vaso-settings-section vaso-settings-${id}`);
		this.sections.set(id, { el, render });
		render(el);
	}

	/** Re-render one section in place (keeps the scroll position). */
	private rerender(id: SectionId): void {
		const sec = this.sections.get(id);
		if (!sec) return;
		sec.el.empty();
		sec.render(sec.el);
	}

	/** Re-render a section once a slider is released (not while it's being dragged). */
	private rerenderOnRelease(sliderEl: HTMLInputElement, id: SectionId): void {
		sliderEl.addEventListener("change", () => {
			this.saveSoon.run();
			this.rerender(id);
		});
	}

	private async saveNow(...rerender: SectionId[]): Promise<void> {
		this.saveSoon.cancel();
		await this.plugin.saveSettings();
		for (const id of rerender) this.rerender(id);
	}

	// ── Endpoints ────────────────────────────────────────────

	private renderEndpoints(el: HTMLElement, type: EndpointKind): void {
		const list = type === "embedding" ? this.s.embeddingEndpoints : this.s.inferenceEndpoints;
		const group = new SettingGroup(el).setHeading(type === "embedding" ? "Embedding endpoints" : "Inference endpoints");

		group.addSetting((row) =>
			row.setDesc(
				type === "embedding"
					? "Turn notes into vectors for search. Tried in order; the first reachable one is used. Use the same model on all of them: switching models means rebuilding the index."
					: "Write the lore summary. Tried in order; the first reachable one is used.",
			),
		);

		if (Platform.isMobile && list.every((ep) => /\/\/(localhost|127\.0\.0\.1)\b/.test(ep.url))) {
			group.addSetting((row) =>
				row
					.setDesc(
						"On this device, localhost is the device itself. Add an endpoint with your computer's LAN or Tailscale address (HTTPS recommended), or a hosted provider.",
					)
					.setClass("vaso-mobile-hint"),
			);
		}

		list.forEach((ep, i) => group.addSetting((row) => this.renderEndpointRow(row, ep, i, list, type)));

		group.addSetting((row) =>
			row.addButton((b) =>
				b
					.setButtonText("Add endpoint")
					.setCta()
					.onClick(() =>
						new EndpointModal(this.app, createDefaultEndpoint(type), true, (saved) => {
							list.push(saved);
							void this.saveNow(type, "index");
						}).open(),
					),
			),
		);
	}

	private renderEndpointRow(
		row: Setting,
		ep: EndpointConfig,
		i: number,
		list: EndpointConfig[],
		type: EndpointKind,
	): void {
		const host = ep.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
		row.setName(`${i + 1}. ${ep.name || PROVIDER_LABELS[ep.providerType]}`);
		row.setDesc(
			createFragment((f) => {
				f.appendText(`${PROVIDER_LABELS[ep.providerType]} · ${ep.model || "no model"} · ${host || "no URL"}`);
				const result = this.testResults.get(ep.id);
				if (result) {
					f.createEl("br");
					f.createSpan({ cls: result.ok ? "vaso-ok" : "vaso-error", text: result.text });
				}
			}),
		);

		row.addExtraButton((b) =>
			b
				.setIcon("activity")
				.setTooltip("Test connection")
				.onClick(async () => {
					this.testResults.set(ep.id, { ok: true, text: "Testing…" });
					this.rerender(type);
					try {
						const t0 = Date.now();
						await checkEndpoint(ep);
						this.testResults.set(ep.id, { ok: true, text: `✓ Reachable (${Date.now() - t0} ms)` });
					} catch (err) {
						this.testResults.set(ep.id, { ok: false, text: `✗ ${errorMessage(err)}` });
					}
					this.rerender(type);
				}),
		);
		row.addExtraButton((b) =>
			b
				.setIcon("pencil")
				.setTooltip("Edit")
				.onClick(() =>
					new EndpointModal(this.app, ep, false, (saved) => {
						list[i] = saved;
						this.testResults.delete(ep.id);
						void this.saveNow(type, "index");
					}).open(),
				),
		);
		if (list.length > 1) {
			row.addExtraButton((b) => {
				b.setIcon("arrow-up")
					.setTooltip("Try earlier")
					.onClick(() => {
						[list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
						void this.saveNow(type);
					});
				b.setDisabled(i === 0);
			});
			row.addExtraButton((b) => {
				b.setIcon("arrow-down")
					.setTooltip("Try later")
					.onClick(() => {
						[list[i + 1], list[i]] = [list[i]!, list[i + 1]!];
						void this.saveNow(type);
					});
				b.setDisabled(i === list.length - 1);
			});
		}
		row.addExtraButton((b) =>
			b
				.setIcon("trash-2")
				.setTooltip("Remove")
				.onClick(() =>
					new ConfirmModal(
						this.app,
						"Remove endpoint?",
						`"${ep.name || ep.url}" will be removed from the ${type} endpoints.`,
						"Remove",
						() => {
							list.splice(i, 1);
							void this.saveNow(type, "index");
						},
					).open(),
				),
		);
	}

	// ── Index ────────────────────────────────────────────────

	private renderIndex(el: HTMLElement): void {
		const store = this.plugin.store;
		const group = new SettingGroup(el).setHeading("Index");

		group.addSetting((row) => {
			row.setName("Status");
			const mismatch = store.index ? indexMismatch(store.index, this.s) : null;
			let status: string;
			if (store.progress) {
				const { label, done, total } = store.progress;
				status = total ? `${label}: ${done}/${total} chunks` : `${label}…`;
			} else if (!hasIndexScope(this.s)) {
				status = "Choose at least one folder below.";
			} else if (mismatch) {
				status = `${mismatch} Rebuild to use the index again.`;
			} else if (store.problem) {
				status = store.problem;
			} else if (store.chunkCount > 0) {
				status = `${store.chunkCount} chunks from ${store.pageCount} pages · updated ${new Date(store.index!.builtAt).toLocaleString()}`;
			} else {
				status = "Not built yet.";
			}
			row.setDesc(status);
			const busy = !!store.progress;
			row.addButton((b) =>
				b
					.setButtonText("Update")
					.setTooltip("Embed new and changed notes")
					.setDisabled(busy || !hasIndexScope(this.s))
					.onClick(() => void store.update(true)),
			);
			row.addButton((b) => {
				b.setButtonText("Rebuild")
					.setTooltip("Embed every note again")
					.setDisabled(busy || !hasIndexScope(this.s))
					.onClick(() => void store.rebuild());
				if (mismatch || store.needsRebuild) b.setCta();
			});
		});

		group.addSetting((row) =>
			row
				.setName("Notes in the vault root")
				.setDesc("Also index notes that aren't in any folder.")
				.addToggle((t) =>
					t.setValue(this.s.indexRoot).onChange((v) => {
						this.s.indexRoot = v;
						void this.saveNow("index");
					}),
				),
		);

		group.addSetting((row) =>
			row
				.setName("Folders")
				.setDesc("Notes in these folders (and their subfolders) are indexed.")
				.addButton((b) =>
					b.setButtonText("Add folder").onClick(() =>
						new FolderSuggestModal(this.app, new Set(this.s.indexedDirectories), (path) => {
							this.s.indexedDirectories.push(path);
							void this.saveNow("index");
						}).open(),
					),
				),
		);
		this.s.indexedDirectories.forEach((dir, i) =>
			group.addSetting((row) => {
				row.setClass("vaso-folder-row").setName(dir);
				if (!this.app.vault.getFolderByPath(dir.replace(/\/+$/, ""))) row.setDesc("Folder not found");
				row.addExtraButton((b) =>
					b
						.setIcon("x")
						.setTooltip("Stop indexing this folder")
						.onClick(() => {
							this.s.indexedDirectories.splice(i, 1);
							void this.saveNow("index");
						}),
				);
			}),
		);

		group.addSetting((row) =>
			row
				.setName("Chunk size (words)")
				.setDesc("Notes are split into pieces of about this many words. Changing it requires a rebuild.")
				.addSlider((sl) =>
					sl
						.setLimits(100, 1000, 50)
						.setValue(this.s.chunkSize)
						.setDynamicTooltip()
						.onChange((v) => {
							this.s.chunkSize = v;
							this.s.chunkOverlap = Math.min(this.s.chunkOverlap, v - 1);
							this.saveSoon();
						})
						.then((c) => this.rerenderOnRelease(c.sliderEl, "index")),
				),
		);
		group.addSetting((row) =>
			row
				.setName("Chunk overlap (words)")
				.setDesc("Words shared by neighbouring pieces, so ideas aren't cut in half. Changing it requires a rebuild.")
				.addSlider((sl) =>
					sl
						.setLimits(0, 200, 10)
						.setValue(this.s.chunkOverlap)
						.setDynamicTooltip()
						.onChange((v) => {
							this.s.chunkOverlap = Math.min(v, this.s.chunkSize - 1);
							this.saveSoon();
						})
						.then((c) => this.rerenderOnRelease(c.sliderEl, "index")),
				),
		);
		group.addSetting((row) =>
			row
				.setName("Re-index edited notes after (seconds)")
				.setDesc("Edited notes are re-embedded after this pause. 0 turns automatic updates off (use Update).")
				.addSlider((sl) =>
					sl
						.setLimits(0, 60, 1)
						.setValue(Math.round(this.s.indexDebounceMs / 1000))
						.setDynamicTooltip()
						.onChange((v) => {
							this.s.indexDebounceMs = v * 1000;
							this.saveSoon();
						}),
				),
		);
	}

	// ── Prompt ───────────────────────────────────────────────

	private renderPrompt(el: HTMLElement): void {
		const group = new SettingGroup(el).setHeading("Prompt");
		const preview = (text: string, def: string) =>
			createFragment((f) => {
				if (text === def) f.createSpan({ cls: "vaso-tag", text: "Default" });
				else f.createSpan({ cls: "vaso-tag is-custom", text: "Customised" });
				f.createDiv({ cls: "vaso-prompt-preview", text: text.trim().slice(0, 160) + (text.length > 160 ? "…" : "") });
			});

		group.addSetting((row) =>
			row
				.setName("System prompt")
				.setDesc(preview(this.s.systemPrompt, DEFAULT_SYSTEM_PROMPT))
				.addButton((b) =>
					b.setButtonText("Edit").onClick(() =>
						new PromptModal(this.app, {
							title: "System prompt",
							description: "Instructions for the model: what to look for and how to format the answer.",
							value: this.s.systemPrompt,
							defaultValue: DEFAULT_SYSTEM_PROMPT,
							onSave: (v) => {
								this.s.systemPrompt = v;
								void this.saveNow("prompt");
							},
						}).open(),
					),
				),
		);

		group.addSetting((row) =>
			row
				.setName("Message template")
				.setDesc(preview(this.s.userPromptTemplate, DEFAULT_USER_PROMPT_TEMPLATE))
				.addButton((b) =>
					b.setButtonText("Edit").onClick(() =>
						new PromptModal(this.app, {
							title: "Message template",
							description: "How your writing and the matched lore are laid out in the message sent with the system prompt.",
							value: this.s.userPromptTemplate,
							defaultValue: DEFAULT_USER_PROMPT_TEMPLATE,
							variables: TEMPLATE_VARIABLES,
							onSave: (v) => {
								this.s.userPromptTemplate = v.trim() ? v : DEFAULT_USER_PROMPT_TEMPLATE;
								void this.saveNow("prompt");
							},
						}).open(),
					),
				),
		);

		group.addSetting((row) =>
			row
				.setName("Writing context (words)")
				.setDesc("How much of the note you're writing is sent: the last N words. 0 sends the whole note.")
				.addSlider((sl) =>
					sl
						.setLimits(0, 2000, 50)
						.setValue(this.s.contextWords)
						.setDynamicTooltip()
						.onChange((v) => {
							this.s.contextWords = v;
							this.saveSoon();
						}),
				),
		);

		group.addSetting((row) =>
			row
				.setName("Leave out frontmatter")
				.setDesc("Strip YAML frontmatter from notes. Changing it requires a rebuild.")
				.addToggle((t) =>
					t.setValue(this.s.stripFrontmatter).onChange((v) => {
						this.s.stripFrontmatter = v;
						void this.saveNow("index");
					}),
				),
		);
		group.addSetting((row) =>
			row
				.setName("Leave out callouts")
				.setDesc("Strip > [!type] callout blocks from notes. Changing it requires a rebuild.")
				.addToggle((t) =>
					t.setValue(this.s.stripCallouts).onChange((v) => {
						this.s.stripCallouts = v;
						void this.saveNow("prompt", "index");
					}),
				),
		);
		if (this.s.stripCallouts) {
			group.addSetting((row) =>
				row
					.setName("Keep these callout types")
					.setDesc("Comma-separated, e.g. example, quote.")
					.addText((t) => {
						t.setPlaceholder("example")
							.setValue(this.s.calloutWhitelist.join(", "))
							.onChange((v) => {
								this.s.calloutWhitelist = v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
								this.saveSoon();
							});
						t.inputEl.addEventListener("blur", () => this.rerender("index"));
						t.inputEl.autocapitalize = "off";
					}),
			);
		}
	}

	// ── Retrieval ────────────────────────────────────────────

	private renderRetrieval(el: HTMLElement): void {
		const group = new SettingGroup(el).setHeading("What gets retrieved");
		const slider = (name: string, desc: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) =>
			group.addSetting((row) =>
				row
					.setName(name)
					.setDesc(desc)
					.addSlider((sl) =>
						sl
							.setLimits(min, max, step)
							.setValue(get())
							.setDynamicTooltip()
							.onChange((v) => {
								set(v);
								this.saveSoon();
							}),
					),
			);

		slider(
			"Paragraph matches (L0)",
			"Excerpts most similar to the paragraph you're editing. 0 turns this off.",
			0, 10, 1,
			() => this.s.l0Chunks,
			(v) => (this.s.l0Chunks = v),
		);
		group.addSetting((row) =>
			row
				.setName("Include neighbouring paragraphs")
				.setDesc("Match against the paragraph before and after the cursor too.")
				.addToggle((t) =>
					t.setValue(this.s.l0IncludeNeighborParagraphs).onChange((v) => {
						this.s.l0IncludeNeighborParagraphs = v;
						this.saveSoon();
					}),
				),
		);
		group.addSetting((row) =>
			row
				.setName("Paragraph match detail")
				.setDesc("How much of each paragraph match is sent.")
				.addDropdown((dd) =>
					dd
						.addOptions({ chunk: "The excerpt", nearby: "Excerpt and its neighbours", page: "The whole page" })
						.setValue(this.s.l0Depth)
						.onChange((v) => {
							this.s.l0Depth = v as L0Depth;
							void this.saveNow("retrieval");
						}),
				),
		);
		if (this.s.l0Depth === "nearby") {
			slider(
				"Neighbouring excerpts",
				"How many excerpts before and after each match are included.",
				1, 5, 1,
				() => this.s.l0NearbyRadius,
				(v) => (this.s.l0NearbyRadius = v),
			);
		}
		slider(
			"Related pages (L1)",
			"Pages most similar to the whole note; sent in full (up to the word limit).",
			0, 10, 1,
			() => this.s.l1Chunks,
			(v) => (this.s.l1Chunks = v),
		);
		slider(
			"Extra excerpts (L2)",
			"Further excerpts from pages not already included.",
			0, 15, 1,
			() => this.s.l2Chunks,
			(v) => (this.s.l2Chunks = v),
		);
		slider(
			"Word limit per page",
			"Full pages are cut after this many words.",
			200, 3000, 100,
			() => this.s.l1MaxPageWords,
			(v) => (this.s.l1MaxPageWords = v),
		);
	}

	// ── Panel ────────────────────────────────────────────────

	private renderPanel(el: HTMLElement): void {
		const group = new SettingGroup(el).setHeading("Lore panel");
		group.addSetting((row) =>
			row
				.setName("Update the panel automatically")
				.setDesc("When off, the panel stays as it is until you tap refresh.")
				.addToggle((t) =>
					t.setValue(this.s.contextPanelEnabled).onChange((v) => {
						this.s.contextPanelEnabled = v;
						this.saveSoon();
					}),
				),
		);
		group.addSetting((row) =>
			row
				.setName("Refresh after typing pauses (seconds)")
				.addSlider((sl) =>
					sl
						.setLimits(0.5, 10, 0.5)
						.setValue(this.s.debounceMs / 1000)
						.setDynamicTooltip()
						.onChange((v) => {
							this.s.debounceMs = Math.round(v * 1000);
							this.saveSoon();
						}),
				),
		);
		group.addSetting((row) =>
			row
				.setName("Refresh after switching notes (seconds)")
				.setDesc("Avoids a request for every note you click through.")
				.addSlider((sl) =>
					sl
						.setLimits(0.5, 15, 0.5)
						.setValue(this.s.noteSwitchDebounceMs / 1000)
						.setDynamicTooltip()
						.onChange((v) => {
							this.s.noteSwitchDebounceMs = Math.round(v * 1000);
							this.saveSoon();
						}),
				),
		);
	}

	// ── Advanced ─────────────────────────────────────────────

	private renderAdvanced(el: HTMLElement): void {
		const group = new SettingGroup(el).setHeading("Troubleshooting");
		group.addSetting((row) =>
			row
				.setName("Debug log")
				.setDesc("Write detailed logs (search scores, prompts, server events) to vaso-debug.log in the plugin folder.")
				.addToggle((t) =>
					t.setValue(this.s.debugLogging).onChange((v) => {
						this.s.debugLogging = v;
						void this.saveNow("advanced");
					}),
				),
		);
		if (this.s.debugLogging) {
			group.addSetting((row) =>
				row
					.setName("Log size limit (MB)")
					.setDesc("The log starts over once it's bigger than this.")
					.addSlider((sl) =>
						sl
							.setLimits(1, 10, 1)
							.setValue(this.s.debugLogMaxSizeMB)
							.setDynamicTooltip()
							.onChange((v) => {
								this.s.debugLogMaxSizeMB = v;
								this.saveSoon();
							}),
					),
			);
		}
	}
}
