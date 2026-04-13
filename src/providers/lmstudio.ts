/**
 * LM Studio LLM provider.
 *
 * Supports LM Studio's native `/api/v1/*` endpoints with rich named SSE
 * events (model loading, prompt processing, reasoning, generation), and
 * falls back to the standard OpenAI-compatible `/v1/*` surface for older
 * versions that lack the native API.
 *
 * LM Studio may run on localhost or a remote host (e.g. Tailscale).
 * Streaming uses `fetchStream()` with CORS fallback to `requestUrl`.
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
import { parseSSE, isSSEDone } from "./parse-sse";
import type {
	LLMProvider,
	ModelEntry,
	ModelInfo,
	ChatMessage,
	ChatStats,
	ChatStreamResult,
	StreamCallback,
} from "./types";

// ── Request body helpers ───────────────────────────────────────

/** Build the JSON body for OpenAI-compat `/v1/chat/completions`. */
function buildOpenAIBody(
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

	if (ep.contextSize && ep.contextSize > 0) {
		body.context_length = ep.contextSize;
	}

	if (stream) {
		body.stream_options = { include_usage: true };
	}

	applyCustomParamsFlat(body, ep.customParams);
	return body;
}

/**
 * Build the JSON body for LM Studio native `/api/v1/chat`.
 * Uses `input` + `system_prompt` instead of `messages`.
 */
function buildNativeBody(
	ep: EndpointConfig,
	messages: ChatMessage[],
	stream: boolean,
): Record<string, unknown> {
	// Extract system prompt and combine user/assistant turns into input
	const systemMsg = messages.find((m) => m.role === "system");
	const nonSystem = messages.filter((m) => m.role !== "system");

	// Build input: for a single user message use a string, otherwise use the array
	let input: unknown;
	if (nonSystem.length === 1 && nonSystem[0]!.role === "user") {
		input = nonSystem[0]!.content;
	} else {
		input = nonSystem.map((m) => ({
			role: m.role,
			content: m.content,
		}));
	}

	const body: Record<string, unknown> = {
		model: ep.model,
		input,
		stream,
	};

	if (systemMsg) {
		body.system_prompt = systemMsg.content;
	}

	if (ep.temperature !== undefined && ep.temperature !== null) {
		body.temperature = ep.temperature;
	}

	if (ep.contextSize && ep.contextSize > 0) {
		body.context_length = ep.contextSize;
	}

	applyCustomParamsFlat(body, ep.customParams);
	return body;
}

// ── Model loading ─────────────────────────────────────────────

/** Response shape from GET /api/v1/models. */
interface LMStudioModelsResponse {
	models?: Array<{
		id?: string;
		key?: string;
		loaded_instances?: Array<{
			id?: string;
			config?: { context_length?: number };
		}>;
	}>;
}

/**
 * Check whether `ep.model` is already loaded with the desired context size.
 * Uses `GET /api/v1/models` which exposes `loaded_instances[].config.context_length`.
 * Returns true if the model is loaded with a matching (or larger) context window.
 */
async function isModelLoadedWithContext(
	ep: EndpointConfig,
	headers: Record<string, string>,
): Promise<boolean> {
	const log = getLogger();
	try {
		log.debug("infer", `LM Studio: checking model status via GET /api/v1/models`);
		const raw = (await requestUrlJson(`${ep.url}/api/v1/models`, {
			headers,
		}));
		const data = raw as LMStudioModelsResponse;

		const models = data?.models ?? [];
		log.debug("infer", `LM Studio: /api/v1/models returned ${models.length} model(s)`);

		for (const m of models) {
			const modelKey = m.key ?? m.id ?? "(unknown)";
			const instances = m.loaded_instances ?? [];
			log.debug("infer", `  model="${modelKey}" loaded_instances=${instances.length}`);
			for (const inst of instances) {
				const loadedCtx = inst.config?.context_length ?? 0;
				log.debug("infer", `    instance id="${inst.id}" context_length=${loadedCtx}`);
			}

			if (m.key !== ep.model && m.id !== ep.model) continue;

			log.debug("infer", `  → matched ep.model="${ep.model}", checking context (want >=${ep.contextSize})`);
			for (const inst of instances) {
				const loadedCtx = inst.config?.context_length ?? 0;
				if (loadedCtx >= (ep.contextSize ?? 0)) {
					log.debug("infer", `  → already loaded with ctx=${loadedCtx} >= ${ep.contextSize}, skip load`);
					return true;
				}
				log.debug("infer", `  → instance ctx=${loadedCtx} < ${ep.contextSize}, need reload`);
			}
			if (instances.length === 0) {
				log.debug("infer", `  → model found but no loaded instances`);
			}
		}

		if (!models.some(m => m.key === ep.model || m.id === ep.model)) {
			log.debug("infer", `LM Studio: model "${ep.model}" not found in models list (available: ${models.map(m => m.key ?? m.id).join(", ")})`);
		}
	} catch (err) {
		log.warn("infer", `LM Studio: GET /api/v1/models failed, will load to be safe: ${err}`);
	}
	return false;
}

/**
 * Ensure the model is loaded with the configured context size.
 * First checks `GET /api/v1/models` for an existing loaded instance with
 * matching context length. Only calls `POST /api/v1/models/load` when the
 * model isn't already loaded with the right settings.
 */
async function ensureModelLoaded(ep: EndpointConfig): Promise<void> {
	if (!ep.contextSize || ep.contextSize <= 0) return;

	const log = getLogger();
	const headers = buildAuthHeaders(ep);

	if (await isModelLoadedWithContext(ep, headers)) {
		log.debug("infer", `LM Studio: ${ep.model} already loaded with ctx>=${ep.contextSize}, skipping load`);
		return;
	}

	const body: Record<string, unknown> = {
		model: ep.model,
		context_length: ep.contextSize,
	};

	try {
		log.info("infer", `LM Studio: POSTing /api/v1/models/load model="${ep.model}" context_length=${ep.contextSize}`);
		const loadResult = await requestUrlJson(`${ep.url}/api/v1/models/load`, {
			method: "POST",
			body,
			headers,
		});
		log.info("infer", `LM Studio: load response: ${JSON.stringify(loadResult)}`);
	} catch (err) {
		// Older LM Studio versions may not have this endpoint — just continue
		log.warn("infer", `LM Studio model load request failed (non-fatal): ${err}`);
	}
}

// ── Native streaming (named SSE events) ───────────────────────

/**
 * Stream from LM Studio's native `/api/v1/chat/completions` endpoint,
 * which emits named SSE events for model loading, prompt processing,
 * reasoning, and message generation.
 */
async function consumeNativeStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cb: StreamCallback,
): Promise<ChatStreamResult> {
	const log = getLogger();
	const decoder = new TextDecoder();
	let buffer = "";
	let accumulated = "";
	let reasoningAccumulated = "";
	let stats: ChatStats | null = null;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const { events, remainder } = parseSSE(buffer);
			buffer = remainder;

			for (const ev of events) {
				if (isSSEDone(ev.data)) {
					log.debug("infer", `LM Studio SSE: [DONE]`);
					continue;
				}

				// Log every SSE event for debugging
				log.debug("infer", `LM Studio SSE event="${ev.event || "(unnamed)"}" data=${ev.data.slice(0, 300)}${ev.data.length > 300 ? "…" : ""}`);

				switch (ev.event) {
					// ── Model loading ───────────────────────
					case "model_load.start": {
						cb.onStatus("loading", "Loading model...");
						break;
					}
					case "model_load.progress": {
						let detail = "Loading model...";
						try {
							const d = JSON.parse(ev.data) as { progress?: number };
							if (typeof d.progress === "number") {
								detail = `Loading model (${Math.round(d.progress * 100)}%)`;
							}
						} catch { /* ignore */ }
						cb.onStatus("loading", detail);
						break;
					}
					case "model_load.end": {
						cb.onStatus("loading", "Model loaded");
						break;
					}

					// ── Prompt processing ───────────────────
					case "prompt_processing.start": {
						cb.onStatus("processing");
						break;
					}
					case "prompt_processing.end": {
						break;
					}

					// ── Reasoning / chain-of-thought ────────
					case "reasoning.start": {
						log.info("infer", `LM Studio: reasoning.start`);
						cb.onStatus("reasoning");
						break;
					}
					case "reasoning.delta": {
						if (ev.data.length === 0) {
							log.debug("infer", `LM Studio: reasoning.delta with empty data`);
							break;
						}
						try {
							const parsed = JSON.parse(ev.data) as Record<string, unknown>;
							log.debug("infer", `LM Studio reasoning.delta parsed keys: ${Object.keys(parsed).join(", ")}`);
							// Native API sends content directly, not wrapped in choices/delta
							let token: string | undefined;
							if (typeof parsed.content === "string") {
								token = parsed.content;
							} else {
								// Fallback: try OpenAI delta shape
								const choices = parsed.choices as
									| Array<{ delta?: { content?: string } }>
									| undefined;
								token = choices?.[0]?.delta?.content ?? undefined;
							}
							log.debug("infer", `LM Studio reasoning.delta token: ${typeof token === "string" ? `"${token.slice(0, 100)}"` : String(token)}`);
							if (typeof token === "string" && token.length > 0) {
								reasoningAccumulated += token;
								cb.onReasoning?.(reasoningAccumulated);
							}
						} catch (err) {
							log.warn("infer", `LM Studio reasoning.delta parse error: ${err}`);
						}
						break;
					}
					case "reasoning.end": {
						log.info("infer", `LM Studio: reasoning.end (accumulated ${reasoningAccumulated.length} chars)`);
						break;
					}

					// ── Message content ─────────────────────
					case "message.start": {
						cb.onStatus("generating");
						break;
					}
					case "message.delta": {
						if (ev.data.length === 0) break;
						try {
							const parsed = JSON.parse(ev.data) as Record<string, unknown>;
							// Native API may send content directly or in choices/delta
							let token: string | undefined;
							if (typeof parsed.content === "string") {
								token = parsed.content;
							} else {
								const choices = parsed.choices as
									| Array<{ delta?: { content?: string } }>
									| undefined;
								token = choices?.[0]?.delta?.content ?? undefined;
							}
							if (typeof token === "string" && token.length > 0) {
								accumulated += token;
								cb.onChunk(accumulated);
							}
						} catch { /* skip malformed JSON */ }
						break;
					}
					case "message.end": {
						log.debug("infer", `LM Studio: message.end`);
						if (ev.data.length > 0) {
							try {
								const parsed = JSON.parse(ev.data) as Record<string, unknown>;

								// Extract full text if present
								const choices = parsed.choices as
									| Array<{ message?: { content?: string } }>
									| undefined;
								const fullText = choices?.[0]?.message?.content;
								if (typeof fullText === "string" && fullText.length > 0) {
									accumulated = fullText;
									cb.onChunk(accumulated);
								}

								// Extract usage stats
								const usage = parsed.usage as
									| { prompt_tokens?: number; completion_tokens?: number }
									| undefined;
								if (usage && typeof usage.prompt_tokens === "number") {
									stats = {
										promptTokens: usage.prompt_tokens,
										responseTokens: usage.completion_tokens ?? 0,
										totalDurationMs: 0,
									};
								}
							} catch { /* skip malformed JSON */ }
						}
						cb.onStatus("done");
						break;
					}

					default: {
						log.debug("infer", `LM Studio: unhandled event="${ev.event}"`);
						// Unknown event — handle as standard OpenAI delta in case
						// LM Studio mixes in unnamed events.
						if (ev.event === "" && ev.data.length > 0) {
							try {
								const parsed = JSON.parse(ev.data) as Record<string, unknown>;
								const choices = parsed.choices as
									| Array<{ delta?: { content?: string } }>
									| undefined;
								const token = choices?.[0]?.delta?.content;
								if (typeof token === "string" && token.length > 0) {
									accumulated += token;
									cb.onChunk(accumulated);
								}

								const usage = parsed.usage as
									| { prompt_tokens?: number; completion_tokens?: number }
									| undefined;
								if (usage && typeof usage.prompt_tokens === "number") {
									stats = {
										promptTokens: usage.prompt_tokens,
										responseTokens: usage.completion_tokens ?? 0,
										totalDurationMs: 0,
									};
								}
							} catch { /* skip malformed JSON */ }
						}
						break;
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	// If we never received message.done, still mark as done
	cb.onStatus("done");
	return { text: accumulated, stats };
}

// ── Provider implementation ────────────────────────────────────

export const lmstudioProvider: LLMProvider = {
	// ── Health ────────────────────────────────────────────────
	async healthCheck(ep: EndpointConfig): Promise<void> {
		const headers = buildAuthHeaders(ep);
		// GET /api/v1/models — 200 means healthy
		await requestUrlJson(`${ep.url}/api/v1/models`, { headers });
	},

	// ── Models ───────────────────────────────────────────────
	async listModels(ep: EndpointConfig): Promise<ModelEntry[]> {
		const log = getLogger();
		const headers = buildAuthHeaders(ep);

		// Try LM Studio's native models endpoint first (richer info).
		try {
			const data = (await requestUrlJson(
				`${ep.url}/api/v0/models/list`,
				{ headers },
			)) as {
				data?: Array<{
					id?: string;
					object?: string;
					state?: string;
					max_context_length?: number;
					owned_by?: string;
				}>;
			};

			const models = data?.data ?? [];
			return models.map((m) => ({
				id: m.id ?? "",
				name: m.id ?? "",
				ownedBy: m.owned_by,
				contextLength:
					typeof m.max_context_length === "number"
						? m.max_context_length
						: undefined,
			}));
		} catch (err) {
			log.debug(
				"infer",
				`LM Studio native /api/v0/models/list failed, falling back to /v1/models: ${err}`,
			);
		}

		// Fallback to standard OpenAI-compat endpoint.
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

	// ── Show (not supported — info is in the models list) ───
	async showModel(
		_ep: EndpointConfig,
		_modelName: string,
	): Promise<ModelInfo | null> {
		return null;
	},

	// ── Embed ────────────────────────────────────────────────
	async embedBatch(
		ep: EndpointConfig,
		texts: string[],
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
			`LM Studio embed: model=${ep.model} texts=${texts.length}`,
		);

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

		return parseOpenAIEmbeddings(data, texts.length, "LM Studio");
	},

	// ── Chat (non-streaming) ─────────────────────────────────
	async chat(
		ep: EndpointConfig,
		messages: ChatMessage[],
	): Promise<string> {
		await ensureModelLoaded(ep);

		const log = getLogger();
		const headers = buildAuthHeaders(ep);
		const body = buildOpenAIBody(ep, messages, false);

		log.debug(
			"infer",
			`LM Studio chat: model=${ep.model} msgs=${messages.length}`,
		);

		const data = (await requestUrlJson(
			`${ep.url}/v1/chat/completions`,
			{ method: "POST", body, headers },
		)) as Record<string, unknown>;

		const choices = data?.choices as
			| Array<{ message?: { content?: string } }>
			| undefined;
		return choices?.[0]?.message?.content ?? "";
	},

	// ── Chat (streaming) ─────────────────────────────────────
	async chatStream(
		ep: EndpointConfig,
		messages: ChatMessage[],
		cb: StreamCallback,
		signal?: AbortSignal,
	): Promise<ChatStreamResult> {
		signal?.throwIfAborted();

		if (ep.contextSize && ep.contextSize > 0) {
			cb.onStatus("loading", "Checking model status…");
		}
		await ensureModelLoaded(ep);
		if (ep.contextSize && ep.contextSize > 0) {
			cb.onStatus("loading", "Model loaded");
		}

		const log = getLogger();
		const headers = buildAuthHeaders(ep);

		log.debug(
			"infer",
			`LM Studio chatStream: model=${ep.model} msgs=${messages.length}`,
		);

		// Try the native endpoint first for rich status events.
		try {
			const nativeBody = buildNativeBody(ep, messages, true);
			log.info("infer", `LM Studio: trying native /api/v1/chat`);
			const nativeReader = await fetchStream(
				`${ep.url}/api/v1/chat`,
				nativeBody,
				headers,
				signal,
			);
			return await consumeNativeStream(nativeReader, cb);
		} catch (err) {
			if (signal?.aborted) throw err;
			log.warn(
				"infer",
				`LM Studio native streaming failed, falling back to /v1/: ${err}`,
			);
		}

		// Fallback: standard OpenAI-compat streaming via /v1/
		log.info("infer", `LM Studio: using fallback /v1/chat/completions`);
		const openaiBody = buildOpenAIBody(ep, messages, true);
		const stdReader = await fetchStream(
			`${ep.url}/v1/chat/completions`,
			openaiBody,
			headers,
			signal,
		);
		return consumeOpenAIStream(stdReader, cb, {
			reasoningKeys: ["reasoning_content", "reasoning"],
			initialProcessing: true,
		});
	},

	// ── Unload all models ─────────────────────────────────────
	async unloadAllModels(ep: EndpointConfig): Promise<number | null> {
		const log = getLogger();
		const headers = buildAuthHeaders(ep);

		const raw = (await requestUrlJson(`${ep.url}/api/v1/models`, {
			headers,
		})) as LMStudioModelsResponse;
		const models = raw?.models ?? [];
		const loaded = models.filter(
			(m) => (m.loaded_instances?.length ?? 0) > 0,
		);
		if (loaded.length === 0) return 0;

		let count = 0;
		for (const m of loaded) {
			const model = m.key ?? m.id;
			if (!model) continue;
			try {
				await requestUrlJson(`${ep.url}/api/v1/models/unload`, {
					method: "POST",
					body: { instance_id: model },
					headers,
				});
				log.info("infer", `LM Studio: unloaded ${model}`);
				count++;
			} catch (err) {
				log.warn("infer", `LM Studio: failed to unload ${model}: ${err}`);
			}
		}
		return count;
	},
};
