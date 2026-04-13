import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import {
	applyCustomParamsFlat,
	customParamsToObj,
	buildAuthHeaders,
	requestUrlJson,
	fetchStream,
	logEmbedHttpError,
	parseOpenAIEmbeddings,
	consumeOpenAIStream,
} from "./http";
import type {
	LLMProvider,
	ChatMessage,
	ChatStreamResult,
	StreamCallback,
	ModelEntry,
	ModelInfo,
} from "./types";

// ── Request body builder ───────────────────────────────────────

/** Build the request body for an OpenRouter chat call. */
function buildChatBody(
	ep: EndpointConfig,
	messages: ChatMessage[],
	stream: boolean
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

	// Reasoning / thinking mode
	if (ep.thinkingMode === "on") {
		body.reasoning = { effort: "medium" };
	} else if (
		ep.thinkingMode === "low" ||
		ep.thinkingMode === "medium" ||
		ep.thinkingMode === "high"
	) {
		body.reasoning = { effort: ep.thinkingMode };
	}
	// "off" or undefined → omit reasoning field

	applyCustomParamsFlat(body, ep.customParams);
	return body;
}

// ── Provider implementation ────────────────────────────────────

export const openrouterProvider: LLMProvider = {
	// ── Health check ────────────────────────────────────────
	async healthCheck(ep: EndpointConfig): Promise<void> {
		const headers = buildAuthHeaders(ep);
		await requestUrlJson(`${ep.url}/models`, { headers });
	},

	// ── List models ────────────────────────────────────────
	async listModels(ep: EndpointConfig): Promise<ModelEntry[]> {
		const headers = buildAuthHeaders(ep);
		const data = (await requestUrlJson(`${ep.url}/models`, {
			headers,
		})) as { data?: OpenRouterModel[] };

		const models = data?.data ?? [];
		return models.map((m): ModelEntry => {
			const owner = m.id.includes("/")
				? m.id.split("/")[0]
				: undefined;
			return {
				id: m.id,
				name: m.name ?? m.id,
				ownedBy: owner,
				contextLength: m.context_length,
			};
		});
	},

	// ── Show model ─────────────────────────────────────────
	async showModel(
		_ep: EndpointConfig,
		_modelName: string
	): Promise<ModelInfo | null> {
		return null;
	},

	// ── Embed batch ────────────────────────────────────────
	async embedBatch(
		ep: EndpointConfig,
		texts: string[]
	): Promise<number[][]> {
		if (texts.length === 0) return [];

		const log = getLogger();
		const headers = buildAuthHeaders(ep);

		const body: Record<string, unknown> = {
			model: ep.model,
			input: texts,
			...customParamsToObj(ep.customParams),
		};

		log.debug(
			"embed",
			`OpenRouter embed: ${texts.length} text(s), model=${ep.model}`
		);

		let data: unknown;
		try {
			data = await requestUrlJson(`${ep.url}/embeddings`, {
				method: "POST",
				body,
				headers,
			});
		} catch (err) {
			logEmbedHttpError(log, err);
			throw err;
		}

		return parseOpenAIEmbeddings(data, texts.length, "OpenRouter");
	},

	// ── Chat (non-streaming) ───────────────────────────────
	async chat(
		ep: EndpointConfig,
		messages: ChatMessage[]
	): Promise<string> {
		const log = getLogger();
		const headers = buildAuthHeaders(ep);
		const body = buildChatBody(ep, messages, false);

		log.debug("infer", "OpenRouter chat request body", body);

		const data = (await requestUrlJson(
			`${ep.url}/chat/completions`,
			{
				method: "POST",
				body,
				headers,
			}
		)) as {
			choices?: { message?: { content?: string } }[];
		};

		return data?.choices?.[0]?.message?.content ?? "";
	},

	// ── Chat (streaming) ───────────────────────────────────
	async chatStream(
		ep: EndpointConfig,
		messages: ChatMessage[],
		cb: StreamCallback,
		signal?: AbortSignal
	): Promise<ChatStreamResult> {
		signal?.throwIfAborted();

		const log = getLogger();
		const headers = buildAuthHeaders(ep);
		const body = buildChatBody(ep, messages, true);

		log.debug(
			"infer",
			`OpenRouter stream: model=${ep.model}, msgs=${messages.length}`
		);

		const reader = await fetchStream(
			`${ep.url}/chat/completions`,
			body,
			headers,
			signal
		);

		return consumeOpenAIStream(reader, cb, {
			reasoningKeys: ["reasoning"],
			processingOnComment: true,
		});
	},
};

// ── Internal response types ────────────────────────────────────

/** Shape of a model entry from GET /models. */
interface OpenRouterModel {
	id: string;
	name?: string;
	context_length?: number;
	pricing?: Record<string, unknown>;
}
