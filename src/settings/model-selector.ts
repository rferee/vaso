import { Notice } from "obsidian";
import type { EndpointConfig } from "../types";
import { listModels, showModel } from "../llm";
import type { ModelInfo } from "../llm";
import { getLogger } from "../logger";
import type { SettingsContext } from "./shared";

/**
 * Render the model picker for an endpoint:
 * - editable text input with datalist autocomplete
 * - "Load models" button that fetches the provider's model list
 * - inline model-info badges + parameter chips (when supported by the provider)
 */
export function renderModelSelector(
	ctx: SettingsContext,
	card: HTMLElement,
	ep: EndpointConfig,
): void {
	const wrapper = card.createDiv("vaso-model-selector");

	const modelRow = wrapper.createDiv("vaso-model-row");

	const modelInput = modelRow.createEl("input", {
		cls: "vaso-model-input",
		type: "text",
		value: ep.model,
		placeholder: ep.type === "embedding" ? "mxbai-embed-large" : "qwen3.5:9b",
	});

	const datalistId = `vaso-models-${ep.id}`;
	const datalist = modelRow.createEl("datalist");
	datalist.id = datalistId;
	modelInput.setAttribute("list", datalistId);

	const cachedModels = ctx.modelCache.get(ep.url);
	if (cachedModels) {
		for (const m of cachedModels) {
			datalist.createEl("option", { value: m.id });
		}
	}

	const infoContainer = wrapper.createDiv("vaso-model-info");
	const cachedInfo = ctx.modelInfoCache.get(`${ep.url}::${ep.model}`);
	if (cachedInfo) renderModelInfo(infoContainer, cachedInfo);

	modelInput.addEventListener("change", async () => {
		ep.model = modelInput.value;
		await ctx.plugin.saveSettings();
		void loadAndRenderModelInfo(ctx, ep, infoContainer, { populateParams: true });
	});

	const loadBtn = modelRow.createEl("button", {
		text: "Load models",
		cls: "vaso-model-load-btn",
		title: "Fetch available models from this endpoint",
	});

	loadBtn.addEventListener("click", async () => {
		if (!ep.url) {
			new Notice("Enter a URL first.");
			return;
		}

		loadBtn.textContent = "Loading…";
		loadBtn.disabled = true;
		try {
			const models = await listModels(ep);
			ctx.modelCache.set(ep.url, models);

			datalist.empty();
			for (const m of models) datalist.createEl("option", { value: m.id });

			new Notice(`Found ${models.length} model${models.length === 1 ? "" : "s"}`);

			if (ep.model && models.some((m) => m.id === ep.model)) {
				await loadAndRenderModelInfo(ctx, ep, infoContainer, { populateParams: true });
			}
		} catch (err) {
			getLogger().error("settings", "Failed to list models", err);
			new Notice(`Failed to load models: ${String(err)}`);
		} finally {
			loadBtn.textContent = "Load models";
			loadBtn.disabled = false;
		}
	});
}

/**
 * Fetch model info, render badges/parameters, and optionally hydrate the
 * endpoint's contextSize/temperature/customParams from the model defaults.
 */
async function loadAndRenderModelInfo(
	ctx: SettingsContext,
	ep: EndpointConfig,
	container: HTMLElement,
	opts?: { populateParams?: boolean },
): Promise<void> {
	if (!ep.url || !ep.model) return;

	const infoKey = `${ep.url}::${ep.model}`;
	let info = ctx.modelInfoCache.get(infoKey);

	if (!info) {
		container.empty();
		container.createEl("span", {
			cls: "vaso-model-info-loading",
			text: "Loading model info…",
		});

		try {
			const result = await showModel(ep, ep.model);
			if (!result) {
				container.empty();
				return;
			}
			info = result;
			ctx.modelInfoCache.set(infoKey, info);
		} catch (err) {
			container.empty();
			container.createEl("span", {
				cls: "vaso-model-info-error",
				text: `Could not load model info: ${String(err)}`,
			});
			return;
		}
	}

	renderModelInfo(container, info);
}

function renderModelInfo(container: HTMLElement, info: ModelInfo): void {
	container.empty();

	const badgeRow = container.createDiv("vaso-model-badges");

	if (info.family) {
		badgeRow.createEl("span", {
			cls: "vaso-model-badge",
			text: info.family,
			title: "Model family",
		});
	}
	if (info.parameterSize) {
		badgeRow.createEl("span", {
			cls: "vaso-model-badge",
			text: info.parameterSize,
			title: "Parameter count",
		});
	}
	if (info.quantization) {
		badgeRow.createEl("span", {
			cls: "vaso-model-badge vaso-model-badge-dim",
			text: info.quantization,
			title: "Quantization level",
		});
	}
	if (info.contextLength) {
		const ctxStr = info.contextLength >= 1024
			? `${Math.round(info.contextLength / 1024)}k ctx`
			: `${info.contextLength} ctx`;
		badgeRow.createEl("span", {
			cls: "vaso-model-badge",
			text: ctxStr,
			title: `Context window: ${info.contextLength.toLocaleString()} tokens`,
		});
	}
	for (const cap of info.capabilities) {
		badgeRow.createEl("span", {
			cls: "vaso-model-badge vaso-model-badge-cap",
			text: cap,
			title: `Capability: ${cap}`,
		});
	}

	if (info.parameters.length > 0) {
		const paramsSection = container.createDiv("vaso-model-params");
		paramsSection.createEl("span", {
			cls: "vaso-model-params-title",
			text: "Model defaults:",
		});
		const paramsList = paramsSection.createDiv("vaso-model-params-list");
		for (const p of info.parameters) {
			const tag = paramsList.createEl("span", {
				cls: "vaso-model-param-tag",
			});
			tag.createEl("span", {
				cls: "vaso-model-param-key",
				text: p.key,
			});
			tag.createEl("span", {
				cls: "vaso-model-param-val",
				text: p.value,
			});
		}
	}
}
