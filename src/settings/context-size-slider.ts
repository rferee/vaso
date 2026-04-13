import { Setting } from "obsidian";
import type { EndpointConfig } from "../types";
import type { SettingsContext } from "./shared";

const FALLBACK_MAX_CTX = 131072;

/** Power-of-2 steps from 512 up to and including `maxCtx`. */
function contextSizeSteps(maxCtx: number): number[] {
	const steps: number[] = [];
	let v = 512;
	while (v <= maxCtx) {
		steps.push(v);
		v *= 2;
	}
	if (steps.length === 0 || steps[steps.length - 1]! < maxCtx) {
		steps.push(maxCtx);
	}
	return steps;
}

/** Format a token count for display: "8,192" → "8k" / "131,072" → "128k". */
function fmtCtx(n: number): string {
	if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`;
	return n.toLocaleString();
}

/**
 * Render the power-of-2 context-window slider for an endpoint.
 * The model's max context (when known via `modelInfoCache`) caps the slider.
 */
export function renderContextSizeSlider(
	ctx: SettingsContext,
	card: HTMLElement,
	ep: EndpointConfig,
): void {
	const infoKey = `${ep.url}::${ep.model}`;
	const info = ctx.modelInfoCache.get(infoKey);
	const modelMax = info?.contextLength ?? FALLBACK_MAX_CTX;

	const steps = contextSizeSteps(modelMax);

	const currentVal = ep.contextSize ?? modelMax;
	let currentIdx = steps.length - 1;
	for (let i = 0; i < steps.length; i++) {
		if (steps[i]! >= currentVal) {
			currentIdx = i;
			break;
		}
	}

	const setting = new Setting(card)
		.setName("Context window (num_ctx)")
		.setDesc(
			`Power-of-2 steps up to model max (${fmtCtx(modelMax)}). Leave at max for model default.`,
		);

	const valueLabel = createEl("span", {
		cls: "vaso-ctx-value",
		text: fmtCtx(steps[currentIdx]!),
	});

	setting.addSlider((slider) => {
		slider
			.setLimits(0, steps.length - 1, 1)
			.setValue(currentIdx)
			.setDynamicTooltip()
			.onChange(async (idx) => {
				const val = steps[idx]!;
				valueLabel.textContent = fmtCtx(val);
				// Sentinel: matching the model's max means "use the model default".
				ep.contextSize = val === modelMax ? undefined : val;
				await ctx.plugin.saveSettings();
			});
		// The default tooltip shows the index — replace with the actual token count.
		const sliderEl = slider.sliderEl;
		sliderEl.addEventListener("input", () => {
			const idx = parseInt(sliderEl.value, 10);
			const val = steps[idx]!;
			sliderEl.title = fmtCtx(val);
		});
		return slider;
	});

	setting.controlEl.appendChild(valueLabel);
}
