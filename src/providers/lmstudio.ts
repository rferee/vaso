/**
 * LM Studio provider.
 *
 * Uses the native REST API v1 (LM Studio 0.4+: /api/v1/chat with named SSE
 * events for model loading, prompt processing, reasoning and output) and
 * falls back to the OpenAI-compatible /v1/* surface for older servers or when
 * the native request is rejected.
 */

import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import { errorMessage } from "../errors";
import {
	buildHeaders,
	consumeOpenAIStream,
	customParamsFlat,
	fetchStream,
	joinUrl,
	positiveInt,
	readText,
	requestJson,
} from "./http";
import { parseSSE } from "./parse-sse";
import {
	OPENAI_REASONING_KEYS,
	listOpenAIModels,
	openAIChatBody,
	parseOpenAIEmbeddings,
} from "./openai-compat";
import type { ChatMessage, ChatStats, ChatStreamResult, LLMProvider, ModelInfo, StreamCallback } from "./types";

// ── Native API shapes ─────────────────────────────────────────

interface LMModel {
	key?: string;
	/** "llm", "embedding" or "decision". */
	type?: string;
	display_name?: string;
	publisher?: string;
	architecture?: string;
	params_string?: string;
	quantization?: { name?: string } | null;
	max_context_length?: number | null;
	capabilities?: { vision?: boolean; trained_for_tool_use?: boolean; reasoning?: unknown };
	loaded_instances?: Array<{ id?: string; config?: { context_length?: number } }>;
}

async function nativeModels(ep: EndpointConfig): Promise<LMModel[]> {
	const data = (await requestJson(joinUrl(ep.url, "/api/v1/models"), { headers: buildHeaders(ep) })) as {
		models?: LMModel[];
	};
	return data?.models ?? [];
}

function nativeChatBody(ep: EndpointConfig, messages: ChatMessage[]): Record<string, unknown> {
	const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
	const input = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
	const body: Record<string, unknown> = { model: ep.model, input, stream: true, store: false };
	if (system) body.system_prompt = system;
	// The native API accepts 0..1.
	if (ep.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, ep.temperature));
	if (ep.contextSize && ep.contextSize > 0) body.context_length = ep.contextSize;
	if (ep.thinkingMode) body.reasoning = ep.thinkingMode;
	return { ...body, ...customParamsFlat(ep.customParams) };
}

/** Load the model with the configured context size unless an instance already has at least that much. */
async function ensureModelLoaded(ep: EndpointConfig): Promise<void> {
	if (!ep.contextSize || ep.contextSize <= 0) return;
	const log = getLogger();
	try {
		const model = (await nativeModels(ep)).find((m) => m.key === ep.model);
		if (model?.loaded_instances?.some((i) => (i.config?.context_length ?? 0) >= ep.contextSize!)) return;
		log.info("infer", `LM Studio: loading ${ep.model} with context_length=${ep.contextSize}`);
		await requestJson(joinUrl(ep.url, "/api/v1/models/load"), {
			method: "POST",
			body: { model: ep.model, context_length: ep.contextSize },
			headers: buildHeaders(ep),
		});
	} catch (err) {
		// Older servers lack these endpoints; the chat request loads the model itself.
		log.warn("infer", "LM Studio: model load check failed (continuing)", err);
	}
}

/** Native /api/v1/chat event stream. Throws when the stream reports an error and produced no text. */
async function consumeNativeStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cb: StreamCallback,
): Promise<ChatStreamResult> {
	let buffer = "";
	let text = "";
	let reasoning = "";
	let stats: ChatStats | null = null;
	// Assigned inside `handle`; an object keeps TypeScript from narrowing it to null.
	const failure: { message: string | null } = { message: null };

	const handle = (event: string, data: string) => {
		let d: Record<string, unknown>;
		try {
			d = data ? (JSON.parse(data) as Record<string, unknown>) : {};
		} catch {
			return;
		}
		const pct = (p: unknown) => (typeof p === "number" ? ` (${Math.round(p * 100)}%)` : "");

		switch (event || d.type) {
			case "model_load.start":
				cb.onStatus("loading", "Loading model…");
				break;
			case "model_load.progress":
				cb.onStatus("loading", `Loading model${pct(d.progress)}…`);
				break;
			case "prompt_processing.start":
				cb.onStatus("processing");
				break;
			case "prompt_processing.progress":
				cb.onStatus("processing", `Processing prompt${pct(d.progress)}…`);
				break;
			case "reasoning.start":
				cb.onStatus("reasoning");
				break;
			case "reasoning.delta":
				if (typeof d.content === "string") {
					reasoning += d.content;
					cb.onReasoning?.(reasoning);
				}
				break;
			case "message.start":
				cb.onStatus("generating");
				break;
			case "message.delta":
				if (typeof d.content === "string") {
					text += d.content;
					cb.onChunk(text);
				}
				break;
			case "error": {
				const e = d.error as { message?: unknown } | undefined;
				failure.message = typeof e?.message === "string" ? e.message : data;
				break;
			}
			case "chat.end": {
				const result = d.result as
					| { stats?: Record<string, unknown>; output?: Array<{ type?: string; content?: unknown }> }
					| undefined;
				const s = result?.stats;
				if (s && typeof s.input_tokens === "number") {
					stats = {
						promptTokens: s.input_tokens,
						responseTokens: typeof s.total_output_tokens === "number" ? s.total_output_tokens : 0,
						totalDurationMs: 0,
					};
				}
				if (!text) {
					const out = (result?.output ?? [])
						.filter((o) => o.type === "message" && typeof o.content === "string")
						.map((o) => o.content as string)
						.join("");
					if (out) {
						text = out;
						cb.onChunk(text);
					}
				}
				break;
			}
		}
	};

	await readText(reader, (chunk) => {
		buffer += chunk;
		const { events, remainder } = parseSSE(buffer);
		buffer = remainder;
		for (const ev of events) handle(ev.event, ev.data);
	});
	for (const ev of parseSSE(buffer + "\n\n").events) handle(ev.event, ev.data);

	if (failure.message && !text) throw new Error(`LM Studio: ${failure.message}`);
	cb.onStatus("done");
	return { text, stats };
}

export const lmstudioProvider: LLMProvider = {
	async healthCheck(ep) {
		try {
			await nativeModels(ep);
		} catch {
			// Pre-0.4 servers only have the OpenAI-compatible API.
			await requestJson(joinUrl(ep.url, "/v1/models"), { headers: buildHeaders(ep) });
		}
	},

	async listModels(ep) {
		try {
			const kind = ep.type === "embedding" ? "embedding" : "llm";
			return (await nativeModels(ep))
				.filter((m) => m.key && (!m.type || m.type === kind))
				.map((m) => ({
					id: m.key!,
					name: m.display_name ?? m.key!,
					ownedBy: m.publisher,
					contextLength: positiveInt(m.max_context_length),
					parameterSize: m.params_string,
					kind: m.type === "embedding" ? ("embedding" as const) : ("llm" as const),
				}));
		} catch (err) {
			getLogger().debug("settings", `LM Studio native model list failed, using /v1/models: ${errorMessage(err)}`);
			return listOpenAIModels(joinUrl(ep.url, "/v1/models"), ep);
		}
	},

	async showModel(ep, modelName): Promise<ModelInfo | null> {
		let models: LMModel[];
		try {
			models = await nativeModels(ep);
		} catch {
			return null;
		}
		const m = models.find((x) => x.key === modelName);
		if (!m) return null;
		const caps: string[] = [];
		if (m.capabilities?.reasoning) caps.push("reasoning");
		if (m.capabilities?.vision) caps.push("vision");
		if (m.capabilities?.trained_for_tool_use) caps.push("tools");
		if (m.type === "embedding") caps.push("embedding");
		return {
			parameters: [],
			capabilities: caps,
			contextLength: positiveInt(m.max_context_length),
			family: m.architecture,
			parameterSize: m.params_string,
			quantization: m.quantization?.name,
		};
	},

	async embedBatch(ep, texts) {
		if (texts.length === 0) return [];
		getLogger().debug("embed", `LM Studio embed: ${texts.length} text(s), model=${ep.model}`);
		const data = await requestJson(joinUrl(ep.url, "/v1/embeddings"), {
			method: "POST",
			body: { ...customParamsFlat(ep.customParams), model: ep.model, input: texts },
			headers: buildHeaders(ep),
		});
		return parseOpenAIEmbeddings(data, texts.length, "LM Studio");
	},

	async chatStream(ep, messages, cb, signal) {
		const log = getLogger();
		if (ep.contextSize) cb.onStatus("loading", "Checking model…");
		await ensureModelLoaded(ep);

		try {
			const reader = await fetchStream(joinUrl(ep.url, "/api/v1/chat"), nativeChatBody(ep, messages), buildHeaders(ep), signal);
			return await consumeNativeStream(reader, cb);
		} catch (err) {
			if (signal?.aborted) throw err;
			log.warn("infer", "LM Studio native chat failed, falling back to /v1/chat/completions", err);
		}

		const body = openAIChatBody(ep, messages);
		if (ep.contextSize && ep.contextSize > 0) body.context_length ??= ep.contextSize;
		const reader = await fetchStream(joinUrl(ep.url, "/v1/chat/completions"), body, buildHeaders(ep), signal);
		return consumeOpenAIStream(reader, cb, { reasoningKeys: OPENAI_REASONING_KEYS, initialProcessing: true });
	},

	async unloadAllModels(ep) {
		let count = 0;
		for (const m of await nativeModels(ep)) {
			for (const inst of m.loaded_instances ?? []) {
				if (!inst.id) continue;
				try {
					await requestJson(joinUrl(ep.url, "/api/v1/models/unload"), {
						method: "POST",
						body: { instance_id: inst.id },
						headers: buildHeaders(ep),
					});
					count++;
				} catch (err) {
					getLogger().warn("infer", `LM Studio: failed to unload ${inst.id}`, err);
				}
			}
		}
		return count;
	},
};
