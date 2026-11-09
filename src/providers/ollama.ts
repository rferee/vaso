import type { EndpointConfig } from "../types";
import { getLogger } from "../logger";
import { buildHeaders, customParamsOllama, fetchStream, joinUrl, readText, requestJson } from "./http";
import type {
	ChatMessage,
	ChatStats,
	ChatStreamResult,
	LLMProvider,
	ModelEntry,
	ModelInfo,
	StreamCallback,
} from "./types";

/** Body fields shared by chat and embed: keep_alive, options (incl. num_ctx) and custom params. */
function commonBody(ep: EndpointConfig): Record<string, unknown> {
	const { top, options } = customParamsOllama(ep.customParams);
	if (ep.contextSize && ep.contextSize > 0) options.num_ctx ??= ep.contextSize;
	const body: Record<string, unknown> = { ...top };
	if (ep.keepAlive) body.keep_alive = ep.keepAlive;
	if (Object.keys(options).length > 0) body.options = options;
	return body;
}

function buildChatBody(ep: EndpointConfig, messages: ChatMessage[]): Record<string, unknown> {
	const body = commonBody(ep);
	if (ep.temperature !== undefined) {
		body.options = { temperature: ep.temperature, ...(body.options as Record<string, unknown> | undefined) };
	}
	if (ep.thinkingMode === "on") body.think = true;
	else if (ep.thinkingMode === "off") body.think = false;
	else if (ep.thinkingMode) body.think = ep.thinkingMode;
	return { ...body, model: ep.model, messages, stream: true };
}

function parseStats(obj: Record<string, unknown>): ChatStats | null {
	const prompt = obj.prompt_eval_count;
	const resp = obj.eval_count;
	if (typeof prompt !== "number" || typeof resp !== "number") return null;
	const totalNs = obj.total_duration;
	return {
		promptTokens: prompt,
		responseTokens: resp,
		totalDurationMs: typeof totalNs === "number" ? Math.round(totalNs / 1e6) : 0,
	};
}

/** NDJSON chat stream: one JSON object per line, the last one has `done: true`. */
async function consumeOllamaStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cb: StreamCallback,
): Promise<ChatStreamResult> {
	let buffer = "";
	let text = "";
	let reasoning = "";
	let stats: ChatStats | null = null;
	let phase: "none" | "reasoning" | "generating" = "none";

	const handleLine = (line: string) => {
		if (!line.trim()) return;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof obj.error === "string") throw new Error(obj.error);
		const msg = obj.message as { thinking?: unknown; content?: unknown } | undefined;

		if (typeof msg?.thinking === "string" && msg.thinking) {
			if (phase === "none") {
				cb.onStatus("reasoning");
				phase = "reasoning";
			}
			reasoning += msg.thinking;
			cb.onReasoning?.(reasoning);
		}
		if (typeof msg?.content === "string" && msg.content) {
			if (phase !== "generating") {
				cb.onStatus("generating");
				phase = "generating";
			}
			text += msg.content;
			cb.onChunk(text);
		}
		if (obj.done) stats = parseStats(obj);
	};

	await readText(reader, (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		lines.forEach(handleLine);
	});
	handleLine(buffer);

	cb.onStatus("done");
	return { text, stats };
}

export const ollamaProvider: LLMProvider = {
	async healthCheck(ep) {
		await requestJson(joinUrl(ep.url, "/api/tags"), { headers: buildHeaders(ep) });
	},

	async listModels(ep): Promise<ModelEntry[]> {
		const data = (await requestJson(joinUrl(ep.url, "/api/tags"), { headers: buildHeaders(ep) })) as {
			models?: OllamaTagsModel[];
		};
		return (data?.models ?? []).map((m) => ({
			id: m.model ?? m.name,
			name: m.name,
			ownedBy: m.details?.family,
			parameterSize: m.details?.parameter_size,
		}));
	},

	async showModel(ep, modelName): Promise<ModelInfo | null> {
		const data = (await requestJson(joinUrl(ep.url, "/api/show"), {
			method: "POST",
			body: { model: modelName },
			headers: buildHeaders(ep),
		})) as OllamaShowResponse;

		// "parameters" is newline-separated "key value" pairs.
		const parameters: ModelInfo["parameters"] = [];
		for (const line of (data.parameters ?? "").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			const sp = t.search(/\s/);
			parameters.push(sp === -1 ? { key: t, value: "" } : { key: t.slice(0, sp), value: t.slice(sp).trim() });
		}

		let contextLength: number | undefined;
		for (const [key, val] of Object.entries(data.model_info ?? {})) {
			if (key.endsWith(".context_length") && typeof val === "number") contextLength = val;
		}

		return {
			parameters,
			capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
			contextLength,
			family: data.details?.family,
			parameterSize: data.details?.parameter_size,
			quantization: data.details?.quantization_level,
		};
	},

	async embedBatch(ep, texts) {
		if (texts.length === 0) return [];
		getLogger().debug("embed", `Ollama embed: ${texts.length} text(s), model=${ep.model}`);
		const data = (await requestJson(joinUrl(ep.url, "/api/embed"), {
			method: "POST",
			body: { truncate: true, ...commonBody(ep), model: ep.model, input: texts },
			headers: buildHeaders(ep),
		})) as { embeddings?: number[][] };
		const vecs = data?.embeddings;
		if (!Array.isArray(vecs) || vecs.length !== texts.length) {
			throw new Error("Invalid embedding response from Ollama");
		}
		return vecs;
	},

	async chatStream(ep, messages, cb, signal) {
		getLogger().debug("infer", `Ollama stream: model=${ep.model}`);
		const reader = await fetchStream(joinUrl(ep.url, "/api/chat"), buildChatBody(ep, messages), buildHeaders(ep), signal);
		return consumeOllamaStream(reader, cb);
	},

	async unloadAllModels(ep) {
		const headers = buildHeaders(ep);
		const ps = (await requestJson(joinUrl(ep.url, "/api/ps"), { headers })) as {
			models?: Array<{ model?: string; name?: string }>;
		};
		let count = 0;
		for (const m of ps?.models ?? []) {
			const model = m.model ?? m.name;
			if (!model) continue;
			try {
				// keep_alive: 0 unloads immediately.
				await requestJson(joinUrl(ep.url, "/api/generate"), { method: "POST", body: { model, keep_alive: 0 }, headers });
				count++;
			} catch (err) {
				getLogger().warn("infer", `Ollama: failed to unload ${model}`, err);
			}
		}
		return count;
	},
};

interface OllamaTagsModel {
	name: string;
	model?: string;
	details?: { family?: string; parameter_size?: string };
}

interface OllamaShowResponse {
	parameters?: string;
	model_info?: Record<string, unknown>;
	capabilities?: string[];
	details?: { family?: string; parameter_size?: string; quantization_level?: string };
}
