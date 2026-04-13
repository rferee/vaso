import { Notice, Setting } from "obsidian";
import type { EndpointConfig, ProviderType } from "../types";
import { createDefaultEndpoint, defaultUrlForProvider } from "../types";
import { unloadAllModels } from "../llm";
import type { SettingsContext } from "./shared";
import { renderModelSelector } from "./model-selector";
import { renderContextSizeSlider } from "./context-size-slider";
import { renderCustomParams } from "./custom-params";

function getEndpointList(
	ctx: SettingsContext,
	type: "embedding" | "inference",
): EndpointConfig[] {
	return type === "embedding"
		? ctx.plugin.settings.embeddingEndpoints
		: ctx.plugin.settings.inferenceEndpoints;
}

function setEndpointList(
	ctx: SettingsContext,
	type: "embedding" | "inference",
	list: EndpointConfig[],
): void {
	if (type === "embedding") {
		ctx.plugin.settings.embeddingEndpoints = list;
	} else {
		ctx.plugin.settings.inferenceEndpoints = list;
	}
}

/** Render the "Embedding Endpoints" / "Inference Endpoints" section + add button. */
export function renderEndpointSection(
	ctx: SettingsContext,
	containerEl: HTMLElement,
	title: string,
	desc: string,
	type: "embedding" | "inference",
): void {
	const section = containerEl.createDiv("vaso-ep-section");

	const headerRow = section.createDiv("vaso-ep-section-header");
	headerRow.createEl("h3", { text: title });

	const addBtn = headerRow.createEl("button", { text: "+ Add endpoint" });
	addBtn.addClass("vaso-ep-add-btn");
	addBtn.addEventListener("click", async () => {
		const list = getEndpointList(ctx, type);
		list.push(createDefaultEndpoint(type));
		setEndpointList(ctx, type, list);
		await ctx.plugin.saveSettings();
		ctx.refresh();
	});

	section.createEl("p", {
		cls: "setting-item-description vaso-ep-section-desc",
		text: desc,
	});

	const endpoints = getEndpointList(ctx, type);

	if (endpoints.length === 0) {
		section.createEl("p", {
			cls: "vaso-ep-empty",
			text: "No endpoints configured. Add one above.",
		});
		return;
	}

	for (let idx = 0; idx < endpoints.length; idx++) {
		const ep = endpoints[idx];
		if (!ep) continue;
		renderEndpointCard(ctx, section, ep, type, idx, endpoints.length);
	}
}

function renderEndpointCard(
	ctx: SettingsContext,
	parent: HTMLElement,
	ep: EndpointConfig,
	type: "embedding" | "inference",
	index: number,
	total: number,
): void {
	const card = parent.createDiv("vaso-ep-card");

	// ── Card header: priority, name, move/delete ──
	const cardHeader = card.createDiv("vaso-ep-card-header");

	cardHeader.createEl("span", {
		cls: "vaso-ep-priority",
		text: `#${index + 1}`,
		title: "Priority — tried in this order",
	});

	const nameInput = cardHeader.createEl("input", {
		cls: "vaso-ep-name-input",
		type: "text",
		value: ep.name,
		placeholder: "Endpoint name",
	});
	nameInput.addEventListener("change", async () => {
		ep.name = nameInput.value;
		await ctx.plugin.saveSettings();
	});

	const btnGroup = cardHeader.createDiv("vaso-ep-card-btns");

	if (index > 0) {
		const upBtn = btnGroup.createEl("button", {
			text: "↑",
			title: "Move up (higher priority)",
			cls: "vaso-ep-btn",
		});
		upBtn.addEventListener("click", async () => {
			const list = getEndpointList(ctx, type);
			[list[index - 1]!, list[index]!] = [list[index]!, list[index - 1]!];
			await ctx.plugin.saveSettings();
			ctx.refresh();
		});
	}

	if (index < total - 1) {
		const downBtn = btnGroup.createEl("button", {
			text: "↓",
			title: "Move down (lower priority)",
			cls: "vaso-ep-btn",
		});
		downBtn.addEventListener("click", async () => {
			const list = getEndpointList(ctx, type);
			[list[index]!, list[index + 1]!] = [list[index + 1]!, list[index]!];
			await ctx.plugin.saveSettings();
			ctx.refresh();
		});
	}

	const deleteBtn = btnGroup.createEl("button", {
		text: "✕",
		title: "Remove endpoint",
		cls: "vaso-ep-btn vaso-ep-btn-danger",
	});
	deleteBtn.addEventListener("click", async () => {
		const list = getEndpointList(ctx, type);
		list.splice(index, 1);
		setEndpointList(ctx, type, list);
		await ctx.plugin.saveSettings();
		ctx.refresh();
	});

	// ── Provider type ──
	new Setting(card)
		.setName("Provider type")
		.setDesc(
			"Ollama, OpenRouter, LM Studio, or generic OpenAI-compatible (vLLM, LocalAI, etc.).",
		)
		.addDropdown((dropdown) =>
			dropdown
				.addOptions({
					ollama: "Ollama",
					openrouter: "OpenRouter",
					lmstudio: "LM Studio",
					"openai-compat": "OpenAI-compatible",
				})
				.setValue(ep.providerType)
				.onChange(async (value) => {
					const pt = value as ProviderType;
					const oldDefault = defaultUrlForProvider(ep.providerType);
					ep.providerType = pt;
					// Auto-fill default URL if the current URL still matches the old provider's default
					if (!ep.url || ep.url === oldDefault) {
						ep.url = defaultUrlForProvider(pt);
					}
					await ctx.plugin.saveSettings();
					ctx.refresh();
				}),
		);

	// ── URL ──
	new Setting(card)
		.setName("URL")
		.addText((text) =>
			text
				.setPlaceholder(defaultUrlForProvider(ep.providerType))
				.setValue(ep.url)
				.onChange(async (value) => {
					ep.url = value;
					await ctx.plugin.saveSettings();
				}),
		);

	// ── API Key (OpenRouter required, others optional) ──
	if (ep.providerType !== "ollama") {
		const keyDesc = ep.providerType === "openrouter"
			? "Required. Get your key at openrouter.ai/keys."
			: "Optional. Leave empty if your server doesn't require authentication.";
		new Setting(card)
			.setName("API key")
			.setDesc(keyDesc)
			.addText((text) =>
				text
					.setPlaceholder(ep.providerType === "openrouter" ? "sk-or-..." : "")
					.setValue(ep.apiKey ?? "")
					.onChange(async (value) => {
						ep.apiKey = value.trim() || undefined;
						await ctx.plugin.saveSettings();
					}),
			);
	}

	renderModelSelector(ctx, card, ep);
	renderContextSizeSlider(ctx, card, ep);

	// ── Keep-alive (Ollama only) ──
	if (ep.providerType === "ollama") {
		new Setting(card)
			.setName("Keep-alive (unload timeout)")
			.setDesc(
				'How long to keep the model loaded after a request. Examples: "5m", "1h", "0" (unload immediately), "-1" (forever). Empty = Ollama default (5m).',
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. 30m")
					.setValue(ep.keepAlive ?? "")
					.onChange(async (value) => {
						ep.keepAlive = value.trim() || undefined;
						await ctx.plugin.saveSettings();
					}),
			);
	}

	// ── Unload all models (Ollama & LM Studio) ──
	if (ep.providerType === "ollama" || ep.providerType === "lmstudio") {
		new Setting(card)
			.setName("Unload all models")
			.setDesc("Free VRAM by unloading every model currently loaded on this server.")
			.addButton((btn) =>
				btn
					.setButtonText("Unload all")
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Unloading…");
						try {
							const count = await unloadAllModels(ep);
							if (count === null) {
								new Notice("Unload not supported for this provider.");
							} else if (count === 0) {
								new Notice("No models were loaded.");
							} else {
								new Notice(`Unloaded ${count} model${count > 1 ? "s" : ""}.`);
							}
						} catch (err) {
							new Notice(`Failed to unload: ${err}`);
						}
						btn.setDisabled(false);
						btn.setButtonText("Unload all");
					}),
			);
	}

	// ── Inference-only params ──
	if (type === "inference") {
		new Setting(card)
			.setName("Temperature")
			.setDesc("0 = deterministic, higher = more creative (0–2).")
			.addText((text) =>
				text
					.setPlaceholder("0.7")
					.setValue(
						ep.temperature !== undefined && ep.temperature !== null
							? String(ep.temperature)
							: "",
					)
					.onChange(async (value) => {
						const n = parseFloat(value);
						ep.temperature = isNaN(n) ? undefined : n;
						await ctx.plugin.saveSettings();
					}),
			);

		// Thinking mode (Ollama + OpenRouter)
		if (ep.providerType === "ollama" || ep.providerType === "openrouter") {
			new Setting(card)
				.setName("Thinking mode")
				.setDesc(
					"Controls reasoning. Ollama: on/off/low/medium/high. OpenRouter: maps to reasoning effort. Default = model decides.",
				)
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({
							"": "Default (omit)",
							off: "Off (think: false)",
							on: "On (think: true)",
							low: "Low (gpt-oss)",
							medium: "Medium (gpt-oss)",
							high: "High (gpt-oss)",
						})
						.setValue(ep.thinkingMode ?? "")
						.onChange(async (value) => {
							ep.thinkingMode = value as EndpointConfig["thinkingMode"];
							await ctx.plugin.saveSettings();
						}),
				);
		}
	}

	renderCustomParams(ctx, card, ep);
}
