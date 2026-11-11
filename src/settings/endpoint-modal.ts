import { Modal, Notice, Platform, Setting } from "obsidian";
import type { App } from "obsidian";
import type { EndpointConfig, ProviderType, ThinkingMode } from "../types";
import { PROVIDER_LABELS, defaultUrlForProvider } from "../types";
import { checkEndpoint, embedTexts, listModels, showModel, unloadAllModels } from "../llm";
import type { ModelEntry, ModelInfo } from "../llm";
import { errorMessage } from "../errors";
import { ModelSuggestModal } from "./suggest";

const CONTEXT_FALLBACK_MAX = 131072;

/** Providers that honour the context-window setting. */
const USES_CONTEXT: ProviderType[] = ["ollama", "lmstudio"];
/** Providers with a thinking/reasoning control. */
const USES_THINKING: ProviderType[] = ["ollama", "openrouter", "lmstudio"];

/**
 * Whether the context-window setting reaches the server for this endpoint.
 * LM Studio applies it only when loading a model for chat; its embedding
 * requests don't carry it.
 */
export function usesContextSize(ep: Pick<EndpointConfig, "type" | "providerType">): boolean {
	if (ep.type === "embedding" && ep.providerType === "lmstudio") return false;
	return USES_CONTEXT.includes(ep.providerType);
}

export function fmtTokens(n: number): string {
	return n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : n.toLocaleString();
}

/**
 * Edit one endpoint on a copy; nothing is saved until Save. Full-screen on
 * phones, so every field gets room.
 */
export class EndpointModal extends Modal {
	private draft: EndpointConfig;
	private info: ModelInfo | null = null;
	private infoFor = "";
	private infoSeq = 0;
	/** Origin of the server the API key was entered for; automatic lookups elsewhere go without it. */
	private keyOrigin: string | null;
	/** Re-rendered in place when model info arrives, so focus elsewhere isn't lost. */
	private infoEl: HTMLElement | null = null;
	private contextEl: HTMLElement | null = null;

	constructor(
		app: App,
		endpoint: EndpointConfig,
		private isNew: boolean,
		private onSave: (ep: EndpointConfig) => void,
	) {
		super(app);
		this.draft = JSON.parse(JSON.stringify(endpoint)) as EndpointConfig;
		this.keyOrigin = urlOrigin(endpoint.url);
	}

	onOpen(): void {
		this.modalEl.addClass("vaso-endpoint-modal");
		const kind = this.draft.type === "embedding" ? "embedding" : "inference";
		this.setTitle(this.isNew ? `New ${kind} endpoint` : `Edit ${kind} endpoint`);
		this.render();
		void this.loadInfo();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		const d = this.draft;
		contentEl.empty();

		new Setting(contentEl).setName("Name").addText((t) =>
			t
				.setPlaceholder(PROVIDER_LABELS[d.providerType])
				.setValue(d.name)
				.onChange((v) => (d.name = v)),
		);

		new Setting(contentEl)
			.setName("Provider")
			.addDropdown((dd) => {
				for (const [k, label] of Object.entries(PROVIDER_LABELS)) dd.addOption(k, label);
				dd.setValue(d.providerType).onChange((v) => {
					const oldDefault = defaultUrlForProvider(d.providerType);
					d.providerType = v as ProviderType;
					if (!d.url || d.url === oldDefault) {
						d.url = defaultUrlForProvider(d.providerType);
						// The key belonged to the old provider's service, not this one.
						d.apiKey = undefined;
					}
					this.info = null;
					this.render();
					void this.loadInfo();
				});
			});

		const urlDesc = createFragment((f) => {
			f.appendText("Base URL of the server.");
			if (Platform.isMobile) {
				f.createEl("br");
				f.appendText(
					"On this device, localhost is the device itself: use your computer's LAN or Tailscale address. " +
						"Plain http:// may be blocked on phones; HTTPS (e.g. tailscale serve) is the safe choice.",
				);
			}
		});
		new Setting(contentEl)
			.setName("URL")
			.setDesc(urlDesc)
			.addText((t) => {
				t.setPlaceholder(defaultUrlForProvider(d.providerType))
					.setValue(d.url)
					.onChange((v) => (d.url = v.trim()));
				plainInput(t.inputEl, "url");
				t.inputEl.addEventListener("blur", () => void this.loadInfo());
			});

		new Setting(contentEl)
			.setName("API key")
			.setDesc(
				d.providerType === "openrouter"
					? "Required. Create one at openrouter.ai/keys."
					: "Optional; for servers behind authentication.",
			)
			.addText((t) => {
				t.setPlaceholder(d.providerType === "openrouter" ? "sk-or-…" : "")
					.setValue(d.apiKey ?? "")
					.onChange((v) => {
						d.apiKey = v.trim() || undefined;
						this.keyOrigin = urlOrigin(d.url);
					});
				t.inputEl.type = "password";
				plainInput(t.inputEl, "text");
				t.inputEl.addEventListener("blur", () => void this.loadInfo());
			});

		// ── Model ──
		const modelSetting = new Setting(contentEl).setName("Model");
		modelSetting.addText((t) => {
			t.setPlaceholder(d.type === "embedding" ? "mxbai-embed-large" : "qwen3.5:9b")
				.setValue(d.model)
				.onChange((v) => (d.model = v.trim()));
			plainInput(t.inputEl, "text");
			t.inputEl.addEventListener("blur", () => void this.loadInfo());
		});
		modelSetting.addButton((b) => b.setButtonText("Browse").onClick(() => void this.browseModels()));
		this.infoEl = contentEl.createDiv("vaso-model-info");
		this.renderInfo(this.infoEl);

		// ── Tuning ──
		this.contextEl = contentEl.createDiv();
		this.renderContextSize(this.contextEl);

		if (d.providerType === "ollama") {
			new Setting(contentEl)
				.setName("Keep model loaded for")
				.setDesc('Ollama keep_alive: "5m", "1h", "0" unloads right away, "-1" keeps it loaded. Empty = Ollama default.')
				.addText((t) => {
					t.setPlaceholder("5m")
						.setValue(d.keepAlive ?? "")
						.onChange((v) => (d.keepAlive = v.trim() || undefined));
					plainInput(t.inputEl, "text");
				});
		}

		if (d.type === "inference") {
			new Setting(contentEl)
				.setName("Temperature")
				.setDesc("0 is focused, higher is more varied (0–2). Empty = model default.")
				.addText((t) => {
					t.setPlaceholder("default")
						.setValue(d.temperature === undefined ? "" : String(d.temperature))
						.onChange((v) => {
							const n = parseFloat(v.replace(",", "."));
							d.temperature = v.trim() === "" || isNaN(n) ? undefined : Math.min(2, Math.max(0, n));
						});
					t.inputEl.inputMode = "decimal";
				});

			if (USES_THINKING.includes(d.providerType)) {
				new Setting(contentEl)
					.setName("Thinking")
					.setDesc("Reasoning before answering. Low/medium/high work on models that support effort levels.")
					.addDropdown((dd) =>
						dd
							.addOptions({ "": "Model default", off: "Off", on: "On", low: "Low", medium: "Medium", high: "High" })
							.setValue(d.thinkingMode ?? "")
							.onChange((v) => (d.thinkingMode = (v || undefined) as ThinkingMode | undefined)),
					);
			}
		}

		this.renderCustomParams(contentEl);

		if (d.providerType === "ollama" || d.providerType === "lmstudio") {
			new Setting(contentEl)
				.setName("Unload all models")
				.setDesc("Free memory on this server by unloading every loaded model.")
				.addButton((b) =>
					b.setButtonText("Unload").onClick(async () => {
						b.setDisabled(true);
						try {
							const n = await unloadAllModels(this.draft);
							new Notice(n ? `Unloaded ${n} model${n === 1 ? "" : "s"}.` : "No models were loaded.");
						} catch (err) {
							new Notice(`Couldn't unload: ${errorMessage(err)}`);
						} finally {
							b.setDisabled(false);
						}
					}),
				);
		}

		// ── Footer ──
		const footer = new Setting(contentEl).setClass("vaso-modal-footer");
		const result = footer.descEl;
		footer
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					b.setDisabled(true);
					result.setText("Testing…");
					result.removeClass("mod-success", "mod-warning");
					try {
						const msg = await this.test();
						result.setText(`✓ ${msg}`);
						result.addClass(msg.startsWith("Connected, but") ? "mod-warning" : "mod-success");
					} catch (err) {
						result.setText(`✗ ${errorMessage(err)}`);
						result.addClass("mod-warning");
					} finally {
						b.setDisabled(false);
					}
				}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						if (!d.url) return void new Notice("Enter a URL.");
						if (!d.model) return void new Notice("Enter a model.");
						d.name = d.name.trim() || PROVIDER_LABELS[d.providerType];
						d.customParams = d.customParams.filter((p) => p.key.trim());
						this.onSave(d);
						this.close();
					}),
			);
	}

	private renderContextSize(parent: HTMLElement): void {
		const d = this.draft;
		parent.empty();
		if (!usesContextSize(d)) return;
		const known = this.info?.contextLength;
		// The options double up to `max`: it must be a sane positive integer.
		const max = known !== undefined && Number.isSafeInteger(known) && known > 0 ? known : CONTEXT_FALLBACK_MAX;
		const options: Record<string, string> = { "": "Model default" };
		for (let v = 2048; v <= max; v *= 2) options[String(v)] = fmtTokens(v);
		if (max % 1024 !== 0 || !options[String(max)]) options[String(max)] = `${fmtTokens(max)} (max)`;
		if (d.contextSize && !options[String(d.contextSize)]) options[String(d.contextSize)] = fmtTokens(d.contextSize);

		new Setting(parent)
			.setName("Context window")
			.setDesc(
				d.providerType === "ollama"
					? "Ollama num_ctx. Bigger fits more lore but uses more memory."
					: "Context length LM Studio loads the model with. Bigger fits more lore but uses more memory.",
			)
			.addDropdown((dd) =>
				dd
					.addOptions(options)
					.setValue(d.contextSize ? String(d.contextSize) : "")
					.onChange((v) => (d.contextSize = v ? Number(v) : undefined)),
			);
	}

	private renderCustomParams(parent: HTMLElement): void {
		const d = this.draft;
		new Setting(parent)
			.setName("Extra request parameters")
			.setDesc(
				d.providerType === "ollama"
					? 'Merged into the request body. Prefix with "options." for Ollama model options (e.g. options.top_k). Values: numbers, true/false, JSON or text.'
					: "Merged into the request body (e.g. top_p, max_tokens). Values: numbers, true/false, JSON or text.",
			)
			.addButton((b) =>
				b.setButtonText("Add").onClick(() => {
					d.customParams.push({ key: "", value: "" });
					this.render();
				}),
			);

		d.customParams.forEach((p, i) => {
			new Setting(parent)
				.setClass("vaso-param-row")
				.addText((t) => {
					t.setPlaceholder("key").setValue(p.key).onChange((v) => (p.key = v));
					plainInput(t.inputEl, "text");
				})
				.addText((t) => {
					t.setPlaceholder("value").setValue(p.value).onChange((v) => (p.value = v));
					plainInput(t.inputEl, "text");
				})
				.addExtraButton((b) =>
					b
						.setIcon("trash-2")
						.setTooltip("Remove")
						.onClick(() => {
							d.customParams.splice(i, 1);
							this.render();
						}),
				);
		});
	}

	private renderInfo(el: HTMLElement): void {
		el.empty();
		const info = this.info;
		if (!info) return;
		const badges = el.createDiv("vaso-badges");
		const badge = (text: string, cls = "") => badges.createSpan({ cls: `vaso-model-badge ${cls}`, text });
		if (info.family) badge(info.family);
		if (info.parameterSize) badge(info.parameterSize);
		if (info.quantization) badge(info.quantization, "is-dim");
		if (info.contextLength) badge(`${fmtTokens(info.contextLength)} max context`);
		for (const cap of info.capabilities) badge(cap, "is-cap");
		if (info.parameters.length > 0) {
			el.createDiv({
				cls: "vaso-model-defaults",
				text: "Model defaults: " + info.parameters.map((p) => `${p.key} ${p.value}`).join(" · "),
			});
		}
	}

	/**
	 * Fetch model details (context length, capabilities) for the current server,
	 * key and model. The key goes only to the server it was entered for; Test
	 * and Browse are explicit and always send it.
	 */
	private async loadInfo(): Promise<void> {
		const d = this.draft;
		const origin = urlOrigin(d.url);
		const apiKey = origin !== null && origin === this.keyOrigin ? d.apiKey : undefined;
		const key = `${d.providerType}|${d.url}|${d.model}|${apiKey ?? ""}`;
		if (!d.url || !d.model || key === this.infoFor) return;
		this.infoFor = key;
		const seq = ++this.infoSeq;

		let info: ModelInfo | null = null;
		try {
			info = await showModel({ ...d, apiKey }, d.model);
		} catch {
			info = null;
		}
		if (seq !== this.infoSeq) return; // a newer request owns the display
		this.info = info;
		if (!info) this.infoFor = ""; // let the next blur retry
		if (this.infoEl) this.renderInfo(this.infoEl);
		if (this.contextEl) this.renderContextSize(this.contextEl);
	}

	private async browseModels(): Promise<void> {
		const d = this.draft;
		if (!d.url) return void new Notice("Enter a URL first.");
		const notice = new Notice("Loading models…", 0);
		let models: ModelEntry[] = [];
		let error: string | undefined;
		try {
			models = await listModels(d);
			const wanted = d.type === "embedding" ? "embedding" : "llm";
			if (models.some((m) => m.kind)) models = models.filter((m) => !m.kind || m.kind === wanted);
		} catch (err) {
			error = errorMessage(err);
		} finally {
			notice.hide();
		}
		new ModelSuggestModal(
			this.app,
			models,
			(id) => {
				d.model = id;
				this.render();
				void this.loadInfo();
			},
			error,
		).open();
	}

	/** Health check plus a cheap functional check. Returns a summary; throws on failure. */
	private async test(): Promise<string> {
		const d = this.draft;
		await checkEndpoint(d);
		if (d.type === "embedding") {
			const [vec] = await embedTexts(d, ["Vaso connection test"]);
			if (!vec) throw new Error("The server answered but returned no embedding");
			return `Connected · ${vec.length}-dimensional embeddings`;
		}
		try {
			const models = await listModels(d);
			if (models.length > 0 && !models.some((m) => m.id === d.model)) {
				return `Connected, but "${d.model}" isn't in the server's model list`;
			}
		} catch { /* listing is optional */ }
		return "Connected";
	}
}

/** Origin of `url`, or null when it has none (unparseable, or no host). */
function urlOrigin(url: string): string | null {
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/** Keyboard hints for URL/identifier inputs (no autocorrect or capitals on phones). */
function plainInput(el: HTMLInputElement, mode: "url" | "text"): void {
	el.inputMode = mode;
	el.autocapitalize = "off";
	el.spellcheck = false;
	el.setAttr("autocorrect", "off");
	el.setAttr("autocomplete", "off");
}
