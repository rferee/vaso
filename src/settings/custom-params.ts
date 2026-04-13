import type { EndpointConfig } from "../types";
import type { SettingsContext } from "./shared";

/**
 * Render the custom-params editor (key/value rows + add button).
 * Mutates `ep.customParams` in place; saves on every change.
 */
export function renderCustomParams(
	ctx: SettingsContext,
	card: HTMLElement,
	ep: EndpointConfig,
): void {
	const customHeader = card.createDiv("vaso-ep-custom-header");
	customHeader.createEl("span", {
		text: "Custom parameters",
		cls: "vaso-ep-custom-title",
	});
	const addParamBtn = customHeader.createEl("button", {
		text: "+ Add",
		cls: "vaso-ep-btn",
	});

	const paramsContainer = card.createDiv("vaso-ep-custom-params");

	const renderRows = () => {
		paramsContainer.empty();
		if (ep.customParams.length === 0) {
			paramsContainer.createEl("span", {
				cls: "vaso-ep-custom-hint",
				text: 'Key-value pairs merged into the request body. Prefix key with "options." for Ollama options.',
			});
			return;
		}
		for (let pi = 0; pi < ep.customParams.length; pi++) {
			const p = ep.customParams[pi];
			if (!p) continue;
			const row = paramsContainer.createDiv("vaso-ep-param-row");

			const keyInput = row.createEl("input", {
				type: "text",
				placeholder: "key",
				value: p.key,
				cls: "vaso-ep-param-key",
			});
			keyInput.addEventListener("change", async () => {
				p.key = keyInput.value;
				await ctx.plugin.saveSettings();
			});

			const valInput = row.createEl("input", {
				type: "text",
				placeholder: "value",
				value: p.value,
				cls: "vaso-ep-param-val",
			});
			valInput.addEventListener("change", async () => {
				p.value = valInput.value;
				await ctx.plugin.saveSettings();
			});

			const rmBtn = row.createEl("button", {
				text: "✕",
				cls: "vaso-ep-btn vaso-ep-btn-small",
			});
			rmBtn.addEventListener("click", async () => {
				ep.customParams.splice(pi, 1);
				await ctx.plugin.saveSettings();
				renderRows();
			});
		}
	};

	addParamBtn.addEventListener("click", async () => {
		ep.customParams.push({ key: "", value: "" });
		await ctx.plugin.saveSettings();
		renderRows();
	});

	renderRows();
}
