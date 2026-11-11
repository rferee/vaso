/**
 * LLM facade. Resolves the first reachable endpoint from the settings list and
 * delegates to its provider; the rest of the plugin never touches providers.
 */

import type { EndpointConfig, VasoSettings } from "./types";
import {
	resolveEndpoint,
	getProviderForEndpoint,
	clearResolveCache,
	checkEndpoint,
	forgetEndpoint,
} from "./providers/registry";
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
import { isAbortError, isTimeoutError, raceAbort, withTimeout } from "./errors";

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

/**
 * Run a request on a resolved endpoint. When it fails for any reason but an
 * abort, the cached resolution is dropped: the next request checks the list
 * again and can fail over instead of waiting out the cache.
 */
async function forgetOnFailure<T>(ep: EndpointConfig, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
	try {
		return await request();
	} catch (err) {
		if (!signal?.aborted && !isAbortError(err)) forgetEndpoint(ep);
		throw err;
	}
}

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
 * A server that stops answering must not hold up the index queue forever.
 * Slow hardware gets time in proportion to the text (about 60 tokens/s).
 */
const EMBED_TIMEOUT_MS = 120_000;
const EMBED_TIMEOUT_MS_PER_CHAR = 4;

/**
 * Embed texts with one endpoint and return unit vectors. A failed batch is
 * retried one text at a time; texts that still fail come back as null. Throws
 * when nothing could be embedded (the endpoint is down), when a request times
 * out, and on abort.
 */
export function embedTexts(
	ep: EndpointConfig,
	texts: string[],
	signal?: AbortSignal,
): Promise<(Vector | null)[]> {
	return forgetOnFailure(ep, signal, () => embedWithRetry(ep, texts, signal));
}

async function embedWithRetry(
	ep: EndpointConfig,
	texts: string[],
	signal?: AbortSignal,
): Promise<(Vector | null)[]> {
	if (texts.length === 0) return [];
	signal?.throwIfAborted();
	const provider = getProviderForEndpoint(ep);
	// The provider requests can't be cancelled: on timeout or abort the late answer is dropped.
	const embed = (batch: string[]) => {
		const ms = EMBED_TIMEOUT_MS + batch.reduce((n, t) => n + t.length, 0) * EMBED_TIMEOUT_MS_PER_CHAR;
		return raceAbort(withTimeout(provider.embedBatch(ep, batch), ms, "Embedding request"), signal);
	};
	// Only a non-empty array of finite numbers is a vector: an object with a huge
	// `length` would hang the loop, and a base64 string would give NaNs.
	const unit = (v: unknown) =>
		Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x))
			? toUnitVector(v)
			: null;

	try {
		const vecs = await embed(texts);
		return texts.map((_, i) => unit(vecs[i]));
	} catch (err) {
		// Retrying text by text against a server that stopped answering would only stall longer.
		if (texts.length === 1 || signal?.aborted || isTimeoutError(err)) throw err;
		getLogger().warn("embed", `Batch of ${texts.length} failed, retrying one at a time`, err);
	}

	const out: (Vector | null)[] = [];
	let lastError: unknown;
	for (const text of texts) {
		signal?.throwIfAborted();
		try {
			out.push(unit((await embed([text]))[0]));
		} catch (err) {
			if (signal?.aborted || isTimeoutError(err)) throw err;
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
	const result = await forgetOnFailure(ep, signal, () => getProviderForEndpoint(ep).chatStream(ep, messages, cb, signal));
	return { ...result, endpoint: ep };
}
