/**
 * Generic OpenAI-compatible provider for servers exposing /v1/* (vLLM,
 * llama.cpp server, LocalAI, text-generation-webui, …).
 */

import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import {
	buildHeaders,
	consumeOpenAIStream,
	customParamsFlat,
	fetchStream,
	requestJson,
} from "./http";
import type { ChatMessage, LLMProvider, ModelEntry } from "./types";

/** llama.cpp uses `reasoning_content`; vLLM renamed it to `reasoning`. */
export const OPENAI_REASONING_KEYS = ["reasoning_content", "reasoning"];

/** Base URL ending in /v1 or not — both work. */
export function v1(ep: EndpointConfig, path: string): string {
	const base = ep.url.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base + path : base + "/v1" + path;
}

export function openAIChatBody(ep: EndpointConfig, messages: ChatMessage[]): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: ep.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
	};
	if (ep.temperature !== undefined) body.temperature = ep.temperature;
	return { ...body, ...customParamsFlat(ep.customParams) };
}

/** Parse an OpenAI-style embeddings response into vectors in input order. */
export function parseOpenAIEmbeddings(data: unknown, expected: number, provider: string): number[][] {
	const entries = (data as { data?: Array<{ embedding: number[]; index: number }> } | null)?.data;
	if (!Array.isArray(entries) || entries.length !== expected) {
		throw new Error(`Invalid embedding response from ${provider}`);
	}
	return [...entries].sort((a, b) => a.index - b.index).map((e) => e.embedding);
}

export async function listOpenAIModels(url: string, ep: EndpointConfig): Promise<ModelEntry[]> {
	const data = (await requestJson(url, { headers: buildHeaders(ep) })) as {
		data?: Array<{ id?: string; owned_by?: string }>;
	};
	return (data?.data ?? [])
		.filter((m) => m.id)
		.map((m) => ({ id: m.id!, name: m.id!, ownedBy: m.owned_by }));
}

export const openaiCompatProvider: LLMProvider = {
	async healthCheck(ep) {
		await requestJson(v1(ep, "/models"), { headers: buildHeaders(ep) });
	},

	listModels(ep) {
		return listOpenAIModels(v1(ep, "/models"), ep);
	},

	async showModel() {
		return null;
	},

	async embedBatch(ep, texts) {
		if (texts.length === 0) return [];
		getLogger().debug("embed", `OpenAI-compat embed: ${texts.length} text(s), model=${ep.model}`);
		const data = await requestJson(v1(ep, "/embeddings"), {
			method: "POST",
			body: { ...customParamsFlat(ep.customParams), model: ep.model, input: texts },
			headers: buildHeaders(ep),
		});
		return parseOpenAIEmbeddings(data, texts.length, "the OpenAI-compatible endpoint");
	},

	async chatStream(ep, messages, cb, signal) {
		const reader = await fetchStream(v1(ep, "/chat/completions"), openAIChatBody(ep, messages), buildHeaders(ep), signal);
		return consumeOpenAIStream(reader, cb, { reasoningKeys: OPENAI_REASONING_KEYS });
	},
};
