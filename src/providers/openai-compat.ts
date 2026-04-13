/**
 * Generic OpenAI-compatible LLM provider.
 *
 * Works with any server that exposes the /v1/* API surface (vLLM,
 * text-generation-webui, llama.cpp with --api, etc.).
 */

import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import {
	buildAuthHeaders,
	customParamsToObj,
	applyCustomParamsFlat,
	requestUrlJson,
	fetchStream,
	logEmbedHttpError,
	parseOpenAIEmbeddings,
	consumeOpenAIStream,
} from "./http";
import type {
	LLMProvider,
	ModelEntry,
	ModelInfo,
	ChatMessage,
	ChatStreamResult,
	StreamCallback,
} from "./types";

// ── Request body helpers ───────────────────────────────────────

function buildChatBody(
	ep: EndpointConfig,
	messages: ChatMessage[],
	stream: boolean,
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: ep.model,
		messages,
		stream,
	};

	if (ep.temperature !== undefined && ep.temperature !== null) {
		body.temperature = ep.temperature;
	}

	if (stream) {
		body.stream_options = { include_usage: true };
	}

	applyCustomParamsFlat(body, ep.customParams);
	return body;
}

// ── Provider implementation ────────────────────────────────────

export const openaiCompatProvider: LLMProvider = {
	async healthCheck(ep: EndpointConfig): Promise<void> {
		const headers = buildAuthHeaders(ep);
		await requestUrlJson(`${ep.url}/v1/models`, { headers });
	},

	async listModels(ep: EndpointConfig): Promise<ModelEntry[]> {
		const headers = buildAuthHeaders(ep);
		const data = (await requestUrlJson(`${ep.url}/v1/models`, {
			headers,
		})) as { data?: Array<{ id?: string; owned_by?: string }> };

		const models = data?.data ?? [];
		return models.map((m) => ({
			id: m.id ?? "",
			name: m.id ?? "",
			ownedBy: m.owned_by,
		}));
	},

	async showModel(
		_ep: EndpointConfig,
		_modelName: string,
	): Promise<ModelInfo | null> {
		return null;
	},

	async embedBatch(
		ep: EndpointConfig,
		texts: string[],
	): Promise<number[][]> {
		if (texts.length === 0) return [];

		const headers = buildAuthHeaders(ep);
		const body: Record<string, unknown> = {
			model: ep.model,
			input: texts,
			...customParamsToObj(ep.customParams),
		};

		const log = getLogger();
		log.debug("embed", `OpenAI-compat embed: model=${ep.model} texts=${texts.length}`);

		let data: unknown;
		try {
			data = await requestUrlJson(`${ep.url}/v1/embeddings`, {
				method: "POST",
				body,
				headers,
			});
		} catch (err) {
			logEmbedHttpError(log, err);
			throw err;
		}

		return parseOpenAIEmbeddings(data, texts.length, "OpenAI-compatible endpoint");
	},

	async chat(
		ep: EndpointConfig,
		messages: ChatMessage[],
	): Promise<string> {
		const body = buildChatBody(ep, messages, false);
		const headers = buildAuthHeaders(ep);
		const log = getLogger();

		log.debug("infer", `OpenAI-compat chat: model=${ep.model} msgs=${messages.length}`);

		let data: Record<string, unknown>;
		try {
			data = (await requestUrlJson(`${ep.url}/v1/chat/completions`, {
				method: "POST",
				body,
				headers,
			})) as Record<string, unknown>;
		} catch (err) {
			const errAny = err as Record<string, unknown> | null;
			log.error(
				"infer",
				`OpenAI-compat chat failed: ${errAny?.status}`,
				errAny?.body ?? errAny?.message ?? err,
			);
			throw err;
		}

		const choices = data?.choices as
			| Array<{ message?: { content?: string } }>
			| undefined;
		return choices?.[0]?.message?.content ?? "";
	},

	async chatStream(
		ep: EndpointConfig,
		messages: ChatMessage[],
		cb: StreamCallback,
		signal?: AbortSignal,
	): Promise<ChatStreamResult> {
		const body = buildChatBody(ep, messages, true);
		const headers = buildAuthHeaders(ep);

		getLogger().debug(
			"infer",
			`OpenAI-compat chatStream: model=${ep.model} msgs=${messages.length}`,
		);

		const reader = await fetchStream(
			`${ep.url}/v1/chat/completions`,
			body,
			headers,
			signal,
		);

		return consumeOpenAIStream(reader, cb);
	},
};
