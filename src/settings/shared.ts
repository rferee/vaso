import type VasoPlugin from "../main";
import type { ModelEntry, ModelInfo } from "../llm";

/**
 * Bundle of state passed to every settings sub-renderer.
 *
 * - `modelCache`     — per-URL list of available models, populated by "Load models"
 * - `modelInfoCache` — per (`url::model`) detailed info; drives the context-size slider max
 * - `refresh`        — re-render the entire settings tab (used after structural changes)
 */
export interface SettingsContext {
	plugin: VasoPlugin;
	modelCache: Map<string, ModelEntry[]>;
	modelInfoCache: Map<string, ModelInfo>;
	refresh(): void;
}
