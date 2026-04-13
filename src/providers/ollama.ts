import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import {
	parseParamValue,
	customParamsToObj,
	buildAuthHeaders,
	requestUrlJson,
	fetchStream,
	logEmbedHttpError,
} from "./http";
import type {
	LLMProvider,
	ChatMessage,
	ChatStats,
	ChatStreamResult,
	StreamCallback,
	ModelEntry,
	ModelInfo,
} from "./types";

// ── Request body builder ───────────────────────────────────────

/** Build the request body for an Ollama-native chat call. */
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

	if (ep.keepAlive !== undefined && ep.keepAlive !== "") {
		body.keep_alive = ep.keepAlive;
	}

	const options: Record<string, unknown> = {};

	if (ep.temperature !== undefined && ep.temperature !== null) {
		options.temperature = ep.temperature;
	}

	if (
		ep.contextSize !== undefined &&
		ep.contextSize !== null &&
		ep.contextSize > 0
	) {
		options.num_ctx = ep.contextSize;
	}

	// Merge custom params — keys starting with "options." go into the
	// options sub-object, everything else goes top-level.
	for (const p of ep.customParams) {
		const key = p.key.trim();
		if (key.length === 0) continue;
		const val = parseParamValue(p.value);
		if (key.startsWith("options.")) {
			options[key.slice(8)] = val;
		} else {
			body[key] = val;
		}
	}

	if (Object.keys(options).length > 0) {
		body.options = options;
	}

	// Thinking / reasoning mode
	if (ep.thinkingMode === "on") {
		body.think = true;
	} else if (ep.thinkingMode === "off") {
		body.think = false;
	} else if (
		ep.thinkingMode === "low" ||
		ep.thinkingMode === "medium" ||
		ep.thinkingMode === "high"
	) {
		body.think = ep.thinkingMode;
	}

	return body;
}

// ── Stats parser ───────────────────────────────────────────────

/** Extract token stats from the final Ollama streaming object. */
function parseStats(obj: Record<string, unknown>): ChatStats | null {
	const prompt = obj.prompt_eval_count;
	const resp = obj.eval_count;
	const totalNs = obj.total_duration;
	if (typeof prompt === "number" && typeof resp === "number") {
		return {
			promptTokens: prompt,
			responseTokens: resp,
			totalDurationMs:
				typeof totalNs === "number" ? Math.round(totalNs / 1e6) : 0,
		};
	}
	return null;
}

// ── NDJSON stream consumer ────────────────────────────────────

async function consumeOllamaStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cb: StreamCallback,
): Promise<ChatStreamResult> {
	const decoder = new TextDecoder();
	let accumulated = "";
	let reasoningAccumulated = "";
	let buffer = "";
	let stats: ChatStats | null = null;
	let seenContent = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				try {
					const obj = JSON.parse(trimmed) as Record<string, unknown>;
					const msg = obj.message as Record<string, unknown> | undefined;

					if (msg?.thinking && typeof msg.thinking === "string" && msg.thinking.length > 0) {
						cb.onStatus("reasoning");
						reasoningAccumulated += msg.thinking;
						cb.onReasoning?.(reasoningAccumulated);
					}

					const token = msg?.content;
					if (typeof token === "string" && token.length > 0) {
						if (!seenContent) {
							cb.onStatus("generating");
							seenContent = true;
						}
						accumulated += token;
						cb.onChunk(accumulated);
					}

					if (obj.done) {
						stats = parseStats(obj);
						cb.onStatus("done");
						return { text: accumulated, stats };
					}
				} catch {
					// skip malformed NDJSON lines
				}
			}
		}

		// Process remaining buffer
		if (buffer.trim().length > 0) {
			try {
				const obj = JSON.parse(buffer.trim()) as Record<string, unknown>;
				const msg = obj.message as Record<string, unknown> | undefined;

				if (msg?.thinking && typeof msg.thinking === "string" && msg.thinking.length > 0) {
					cb.onStatus("reasoning");
					reasoningAccumulated += msg.thinking;
					cb.onReasoning?.(reasoningAccumulated);
				}
				const token = msg?.content;
				if (typeof token === "string" && token.length > 0) {
					if (!seenContent) {
						cb.onStatus("generating");
						seenContent = true;
					}
					accumulated += token;
					cb.onChunk(accumulated);
				}
				if (obj.done) {
					stats = parseStats(obj);
				}
			} catch {
				// ignore trailing garbage
			}
		}
	} finally {
		reader.releaseLock();
	}

	cb.onStatus("done");
	return { text: accumulated, stats };
}

// ── Provider implementation ────────────────────────────────────

export const ollamaProvider: LLMProvider = {
	// ── Health check ────────────────────────────────────────
	async healthCheck(ep: EndpointConfig): Promise<void> {
		const headers = buildAuthHeaders(ep);
		await requestUrlJson(`${ep.url}/api/tags`, { headers });
	},

	// ── List models ────────────────────────────────────────
	async listModels(ep: EndpointConfig): Promise<ModelEntry[]> {
		const headers = buildAuthHeaders(ep);
		const data = (await requestUrlJson(`${ep.url}/api/tags`, {
			headers,
		})) as { models?: OllamaTagsModel[] };

		const models = data?.models ?? [];
		return models.map(
			(m): ModelEntry => ({
				id: m.model ?? m.name,
				name: m.name,
				ownedBy: m.details?.family,
				parameterSize: m.details?.parameter_size,
			})
		);
	},

	// ── Show model ─────────────────────────────────────────
	async showModel(
		ep: EndpointConfig,
		modelName: string
	): Promise<ModelInfo | null> {
		const headers = buildAuthHeaders(ep);
		const data = (await requestUrlJson(`${ep.url}/api/show`, {
			method: "POST",
			body: { model: modelName },
			headers,
		})) as OllamaShowResponse;

		// Parse the "parameters" field: newline-separated "key value" pairs
		const params: { key: string; value: string }[] = [];
		if (typeof data.parameters === "string") {
			for (const line of data.parameters.split("\n")) {
				const trimmed = line.trim();
				if (trimmed.length === 0) continue;
				const spaceIdx = trimmed.indexOf(" ");
				if (spaceIdx === -1) {
					params.push({ key: trimmed, value: "" });
				} else {
					params.push({
						key: trimmed.slice(0, spaceIdx).trim(),
						value: trimmed.slice(spaceIdx + 1).trim(),
					});
				}
			}
		}

		// Extract context length and parameter count from model_info
		let contextLength: number | undefined;
		let parameterCount: number | undefined;
		const modelInfo = data.model_info as
			| Record<string, unknown>
			| undefined;
		if (modelInfo) {
			for (const [key, val] of Object.entries(modelInfo)) {
				if (
					key.endsWith(".context_length") &&
					typeof val === "number"
				) {
					contextLength = val;
				}
				if (
					key === "general.parameter_count" &&
					typeof val === "number"
				) {
					parameterCount = val;
				}
			}
		}

		return {
			parameters: params,
			capabilities: Array.isArray(data.capabilities)
				? data.capabilities
				: [],
			details: data.details ?? {
				format: "",
				family: "",
				parameter_size: "",
				quantization_level: "",
			},
			contextLength,
			parameterCount,
		};
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
			truncate: true,
			...customParamsToObj(ep.customParams),
		};
		if (ep.keepAlive !== undefined && ep.keepAlive !== "") {
			body.keep_alive = ep.keepAlive;
		}

		log.debug(
			"embed",
			`Ollama embed: ${texts.length} text(s), model=${ep.model}`
		);

		let data: { embeddings?: number[][] };
		try {
			data = (await requestUrlJson(`${ep.url}/api/embed`, {
				method: "POST",
				body,
				headers,
			})) as { embeddings?: number[][] };
		} catch (err) {
			logEmbedHttpError(log, err);
			throw err;
		}

		const vecs = data?.embeddings;
		if (!Array.isArray(vecs) || vecs.length !== texts.length) {
			throw new Error("Invalid batch embedding response from Ollama");
		}
		return vecs;
	},

	// ── Chat (non-streaming) ───────────────────────────────
	async chat(ep: EndpointConfig, messages: ChatMessage[]): Promise<string> {
		const log = getLogger();
		const headers = buildAuthHeaders(ep);
		const body = buildChatBody(ep, messages, false);

		log.debug("infer", "Ollama chat request body", body);

		const data = (await requestUrlJson(`${ep.url}/api/chat`, {
			method: "POST",
			body,
			headers,
		})) as { message?: { content?: string } };

		return data?.message?.content ?? "";
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
		const body = buildChatBody(ep, messages, true);
		const headers = buildAuthHeaders(ep);

		log.debug(
			"infer",
			`Ollama stream: model=${ep.model}, msgs=${messages.length}`
		);

		const reader = await fetchStream(
			`${ep.url}/api/chat`,
			body,
			headers,
			signal,
		);

		return consumeOllamaStream(reader, cb);
	},

	// ── Unload all models ─────────────────────────────────────
	async unloadAllModels(ep: EndpointConfig): Promise<number | null> {
		const log = getLogger();
		const headers = buildAuthHeaders(ep);

		const ps = (await requestUrlJson(`${ep.url}/api/ps`, { headers })) as {
			models?: Array<{ model?: string; name?: string }>;
		};
		const running = ps?.models ?? [];
		if (running.length === 0) return 0;

		// Unload each by sending keep_alive: 0
		let count = 0;
		for (const m of running) {
			const model = m.model ?? m.name;
			if (!model) continue;
			try {
				await requestUrlJson(`${ep.url}/api/generate`, {
					method: "POST",
					body: { model, keep_alive: 0 },
					headers,
				});
				log.info("infer", `Ollama: unloaded ${model}`);
				count++;
			} catch (err) {
				log.warn("infer", `Ollama: failed to unload ${model}: ${err}`);
			}
		}
		return count;
	},
};

// ── Internal response types ────────────────────────────────────

/** Shape of a model entry from GET /api/tags. */
interface OllamaTagsModel {
	name: string;
	model: string;
	modified_at?: string;
	size?: number;
	details?: {
		format?: string;
		family?: string;
		families?: string[];
		parameter_size?: string;
		quantization_level?: string;
	};
}

/** Shape of the POST /api/show response. */
interface OllamaShowResponse {
	parameters?: string;
	model_info?: Record<string, unknown>;
	capabilities?: string[];
	details?: {
		format: string;
		family: string;
		families?: string[];
		parameter_size: string;
		quantization_level: string;
	};
}
