import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import {
	buildHeaders,
	consumeOpenAIStream,
	customParamsFlat,
	fetchStream,
	HttpError,
	joinUrl,
	requestJson,
} from "./http";
import { openAIChatBody, parseOpenAIEmbeddings } from "./openai-compat";
import type { ChatMessage, LLMProvider, ModelEntry } from "./types";

/** App attribution (https://openrouter.ai/docs/app-attribution). */
const headers = (ep: EndpointConfig) => buildHeaders(ep, { "X-OpenRouter-Title": "Vaso" });

function buildChatBody(ep: EndpointConfig, messages: ChatMessage[]): Record<string, unknown> {
	const body = openAIChatBody(ep, messages);
	if (body.reasoning === undefined) {
		if (ep.thinkingMode === "off") body.reasoning = { effort: "none" };
		else if (ep.thinkingMode === "on") body.reasoning = { enabled: true };
		else if (ep.thinkingMode) body.reasoning = { effort: ep.thinkingMode };
	}
	return body;
}

export const openrouterProvider: LLMProvider = {
	async healthCheck(ep) {
		if (!ep.apiKey) throw new Error("OpenRouter needs an API key");
		// /key is small and validates the key; /models (large) answers without one.
		try {
			await requestJson(joinUrl(ep.url, "/key"), { headers: headers(ep) });
		} catch (err) {
			if (!(err instanceof HttpError && err.status === 404)) throw err;
			await requestJson(joinUrl(ep.url, "/models"), { headers: headers(ep) });
		}
	},

	async listModels(ep): Promise<ModelEntry[]> {
		const data = (await requestJson(joinUrl(ep.url, "/models"), { headers: headers(ep) })) as {
			data?: Array<{ id: string; name?: string; context_length?: number }>;
		};
		return (data?.data ?? []).map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			ownedBy: m.id.includes("/") ? m.id.split("/")[0] : undefined,
			contextLength: m.context_length,
		}));
	},

	async showModel() {
		return null;
	},

	async embedBatch(ep, texts) {
		if (texts.length === 0) return [];
		getLogger().debug("embed", `OpenRouter embed: ${texts.length} text(s), model=${ep.model}`);
		const data = await requestJson(joinUrl(ep.url, "/embeddings"), {
			method: "POST",
			body: { ...customParamsFlat(ep.customParams), model: ep.model, input: texts },
			headers: headers(ep),
		});
		return parseOpenAIEmbeddings(data, texts.length, "OpenRouter");
	},

	async chatStream(ep, messages, cb, signal) {
		const reader = await fetchStream(joinUrl(ep.url, "/chat/completions"), buildChatBody(ep, messages), headers(ep), signal);
		return consumeOpenAIStream(reader, cb, { reasoningKeys: ["reasoning"], processingOnComment: true });
	},
};
