/**
 * LLM facade. Resolves the first reachable endpoint from the settings list and
 * delegates to its provider; the rest of the plugin never touches providers.
 */

import type { EndpointConfig, VasoSettings } from "./types";
import { resolveEndpoint, getProviderForEndpoint, clearResolveCache, checkEndpoint } from "./providers/registry";
import type {
	ChatMessage,
	ChatStreamResult,
	ModelEntry,
	ModelInfo,
	StreamCallback,
} from "./providers/types";
import { toUnitVector } from "./vectors";
import type { Vector } from "./vectors";
import { getLogger } from "./logger";

export type {
	ChatMessage,
	ChatStats,
	ChatStreamResult,
	StreamCallback,
	StreamPhase,
	ModelEntry,
	ModelInfo,
} from "./providers/types";

export { clearResolveCache, checkEndpoint };

// ── Model discovery ─────────────────────────────────────────────

export function listModels(ep: EndpointConfig): Promise<ModelEntry[]> {
	return getProviderForEndpoint(ep).listModels(ep);
}

/** Detailed model info, or null when the provider doesn't expose it. */
export function showModel(ep: EndpointConfig, modelName: string): Promise<ModelInfo | null> {
	return getProviderForEndpoint(ep).showModel(ep, modelName);
}

/** Unload every loaded model. Returns the count, or null when unsupported. */
export async function unloadAllModels(ep: EndpointConfig): Promise<number | null> {
	const provider = getProviderForEndpoint(ep);
	return provider.unloadAllModels ? provider.unloadAllModels(ep) : null;
}

// ── Embedding ───────────────────────────────────────────────────

export function resolveEmbeddingEndpoint(settings: VasoSettings): Promise<EndpointConfig> {
	return resolveEndpoint(settings.embeddingEndpoints, "embed");
}

/**
 * Embed texts with one endpoint and return unit vectors. A failed batch is
 * retried one text at a time; texts that still fail come back as null. Throws
 * when nothing could be embedded (the endpoint is down).
 */
export async function embedTexts(
	ep: EndpointConfig,
	texts: string[],
	signal?: AbortSignal,
): Promise<(Vector | null)[]> {
	if (texts.length === 0) return [];
	signal?.throwIfAborted();
	const provider = getProviderForEndpoint(ep);
	const unit = (v: number[] | undefined) => (v && v.length > 0 ? toUnitVector(v) : null);

	try {
		const vecs = await provider.embedBatch(ep, texts);
		return texts.map((_, i) => unit(vecs[i]));
	} catch (err) {
		if (texts.length === 1) throw err;
		getLogger().warn("embed", `Batch of ${texts.length} failed, retrying one at a time`, err);
	}

	const out: (Vector | null)[] = [];
	let lastError: unknown;
	for (const text of texts) {
		signal?.throwIfAborted();
		try {
			out.push(unit((await provider.embedBatch(ep, [text]))[0]));
		} catch (err) {
			lastError = err;
			out.push(null);
		}
	}
	if (out.every((v) => v === null)) throw lastError ?? new Error("Embedding failed");
	return out;
}

/** Embed a single query text. */
export async function embedQuery(
	ep: EndpointConfig,
	text: string,
	signal?: AbortSignal,
): Promise<Vector> {
	const [vec] = await embedTexts(ep, [text], signal);
	if (!vec) throw new Error("The embedding endpoint returned an empty vector");
	return vec;
}

// ── Chat ────────────────────────────────────────────────────────

export interface ChatStreamWithStatusResult extends ChatStreamResult {
	/** Endpoint that handled the request. */
	endpoint: EndpointConfig;
}

/** Streaming chat on the first reachable inference endpoint. */
export async function chatStreamWithStatus(
	messages: ChatMessage[],
	settings: VasoSettings,
	cb: StreamCallback,
	signal?: AbortSignal,
): Promise<ChatStreamWithStatusResult> {
	signal?.throwIfAborted();
	const ep = await resolveEndpoint(settings.inferenceEndpoints, "infer");
	const result = await getProviderForEndpoint(ep).chatStream(ep, messages, cb, signal);
	return { ...result, endpoint: ep };
}
