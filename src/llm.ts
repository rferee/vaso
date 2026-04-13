/**
 * Public LLM facade — drop-in replacement for the old `ollama.ts`.
 *
 * Every function resolves the best reachable endpoint from the settings list,
 * then delegates to the appropriate provider. Callers never touch providers
 * directly.
 */

import type { VasoSettings, EndpointConfig } from "./types";
import {
	resolveEndpoint,
	getProviderForEndpoint,
	clearResolveCache,
} from "./providers/registry";

export type {
	ChatMessage,
	ChatStats,
	ChatStreamResult,
	StreamCallback,
	StreamPhase,
	ModelEntry,
	ModelInfo,
} from "./providers/types";

export { clearResolveCache };

// ── Model discovery ─────────────────────────────────────────────

import type { ModelEntry, ModelInfo } from "./providers/types";

/**
 * List models available on the given endpoint.
 * (Uses the endpoint directly — no resolution needed.)
 */
export async function listModels(ep: EndpointConfig): Promise<ModelEntry[]> {
	const provider = getProviderForEndpoint(ep);
	return provider.listModels(ep);
}

/**
 * Get detailed model info. Returns null if the provider doesn't support it.
 */
export async function showModel(
	ep: EndpointConfig,
	modelName: string
): Promise<ModelInfo | null> {
	const provider = getProviderForEndpoint(ep);
	return provider.showModel(ep, modelName);
}

/**
 * Unload all loaded models on the given endpoint.
 * Returns the count of models unloaded, or null if not supported.
 */
export async function unloadAllModels(ep: EndpointConfig): Promise<number | null> {
	const provider = getProviderForEndpoint(ep);
	if (!provider.unloadAllModels) return null;
	return provider.unloadAllModels(ep);
}

// ── Embedding ───────────────────────────────────────────────────

/** Get embedding vector for a single text. */
export async function embed(
	text: string,
	settings: VasoSettings,
	signal?: AbortSignal
): Promise<number[]> {
	signal?.throwIfAborted();
	const ep = await resolveEndpoint(settings.embeddingEndpoints);
	const provider = getProviderForEndpoint(ep);
	const vecs = await provider.embedBatch(ep, [text]);
	const vec = vecs[0];
	if (!vec || vec.length === 0) {
		throw new Error("Invalid embedding response");
	}
	return vec;
}

/** Batch-embed multiple texts. Falls back to one-at-a-time on batch failure. */
export async function embedBatch(
	texts: string[],
	settings: VasoSettings,
	signal?: AbortSignal
): Promise<number[][]> {
	if (texts.length === 0) return [];
	signal?.throwIfAborted();

	const ep = await resolveEndpoint(settings.embeddingEndpoints);
	const provider = getProviderForEndpoint(ep);

	// Try the whole batch first
	try {
		return await provider.embedBatch(ep, texts);
	} catch {
		// Fall back to one-at-a-time
	}

	const { getLogger } = await import("./logger");
	getLogger().warn(
		"embed",
		`Batch embed failed (${texts.length} texts), falling back to one-at-a-time`
	);

	const results: number[][] = [];
	for (let i = 0; i < texts.length; i++) {
		try {
			const vecs = await provider.embedBatch(ep, [texts[i]!]);
			results.push(vecs[0]!);
		} catch {
			getLogger().warn(
				"embed",
				`Single embed failed for text #${i}, using zero vector`
			);
			results.push([]);
		}
	}
	return results;
}

// ── Chat (inference) ────────────────────────────────────────────

import type { ChatMessage, ChatStreamResult, StreamCallback } from "./providers/types";

/** Result of chatStreamWithStatus — includes endpoint metadata for UI. */
export interface ChatStreamWithStatusResult extends ChatStreamResult {
	/** Resolved endpoint that handled the request. */
	endpoint: EndpointConfig;
}

/** Human-readable label for a provider type. */
const PROVIDER_LABELS: Record<import("./types").ProviderType, string> = {
	ollama: "Ollama",
	openrouter: "OpenRouter",
	lmstudio: "LM Studio",
	"openai-compat": "OpenAI",
};

/** Get a display label for a provider type. */
export function providerLabel(pt: import("./types").ProviderType): string {
	return PROVIDER_LABELS[pt] ?? pt;
}

/**
 * Streaming chat with full StreamCallback (status phases + content).
 * Use this for the sidebar where status display is needed.
 * Returns the result plus the resolved endpoint for UI labelling.
 */
export async function chatStreamWithStatus(
	messages: ChatMessage[],
	settings: VasoSettings,
	cb: StreamCallback,
	signal?: AbortSignal
): Promise<ChatStreamWithStatusResult> {
	signal?.throwIfAborted();
	const ep = await resolveEndpoint(settings.inferenceEndpoints, "infer");
	const provider = getProviderForEndpoint(ep);
	const result = await provider.chatStream(ep, messages, cb, signal);
	return { ...result, endpoint: ep };
}
