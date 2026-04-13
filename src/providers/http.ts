import { requestUrl } from "obsidian";
import type { CustomParam, EndpointConfig } from "../types";
import type { Logger } from "../logger";
import { parseSSE, isSSEDone } from "./parse-sse";
import type { ChatStats, ChatStreamResult, StreamCallback } from "./types";
import * as http from "http";
import * as https from "https";

// ── Param helpers ───────────────────────────────────────────────

/** Parse a CustomParam string value to its JS type. */
export function parseParamValue(v: string): unknown {
	if (v === "true") return true;
	if (v === "false") return false;
	const n = Number(v);
	if (!isNaN(n) && v.trim().length > 0) return n;
	// JSON objects / arrays
	const trimmed = v.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try { return JSON.parse(trimmed); } catch { /* fall through */ }
	}
	return v;
}

/** Build a plain object from CustomParam[] with parsed values. */
export function customParamsToObj(
	params: CustomParam[]
): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	for (const p of params) {
		if (p.key.trim().length > 0) {
			obj[p.key.trim()] = parseParamValue(p.value);
		}
	}
	return obj;
}

/**
 * Merge custom params into a body at the top level, stripping any "options."
 * prefix (a leftover convention from Ollama-style configs).
 */
export function applyCustomParamsFlat(
	body: Record<string, unknown>,
	params: CustomParam[],
): void {
	for (const p of params) {
		let key = p.key.trim();
		if (key.length === 0) continue;
		if (key.startsWith("options.")) key = key.slice(8);
		body[key] = parseParamValue(p.value);
	}
}

// ── Auth headers ────────────────────────────────────────────────

/** Build HTTP headers for a request to the given endpoint. */
export function buildAuthHeaders(ep: EndpointConfig): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ep.apiKey) {
		headers["Authorization"] = `Bearer ${ep.apiKey}`;
	}
	return headers;
}

// ── requestUrl wrapper (CORS-free, no streaming) ────────────────

/**
 * JSON request via Obsidian's requestUrl (bypasses CORS via Electron net module).
 * Returns the parsed JSON body. Throws on HTTP errors.
 */
export async function requestUrlJson(
	url: string,
	opts: {
		method?: "GET" | "POST";
		body?: unknown;
		headers?: Record<string, string>;
	} = {}
): Promise<unknown> {
	const reqOpts: Parameters<typeof requestUrl>[0] = {
		url,
		method: opts.method ?? "GET",
		headers: opts.headers ?? { "Content-Type": "application/json" },
		throw: true,
	};
	if (opts.body !== undefined) {
		reqOpts.body = JSON.stringify(opts.body);
	}
	const resp = await requestUrl(reqOpts);
	return resp.json;
}

/**
 * Non-throwing variant — returns `{ json, status }` so the caller can inspect
 * the HTTP status without a try/catch.
 */
export async function requestUrlRaw(
	url: string,
	opts: {
		method?: "GET" | "POST";
		body?: unknown;
		headers?: Record<string, string>;
	} = {}
): Promise<{ json: unknown; status: number; text: string }> {
	const reqOpts: Parameters<typeof requestUrl>[0] = {
		url,
		method: opts.method ?? "GET",
		headers: opts.headers ?? { "Content-Type": "application/json" },
	};
	if (opts.body !== undefined) {
		reqOpts.body = JSON.stringify(opts.body);
	}
	const resp = await requestUrl(reqOpts);
	return { json: resp.json, status: resp.status, text: resp.text };
}

// ── Streaming via Node.js HTTP (CORS-free) ──────────────────────

/**
 * Streaming POST via Node.js `http`/`https` modules.
 *
 * Uses Node's native HTTP stack instead of browser `fetch()`, which means
 * CORS is never an issue — Node requests don't go through the browser's
 * CORS preflight machinery. Works for localhost, Tailscale, and remote URLs.
 *
 * Returns a ReadableStreamDefaultReader so existing stream consumers
 * (NDJSON, SSE parsers) work without changes.
 */
export function fetchStream(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
	const parsed = new URL(url);
	const isHttps = parsed.protocol === "https:";
	const reqFn = isHttps ? https.request : http.request;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}

		const req = reqFn(
			url,
			{ method: "POST", headers },
			(res: http.IncomingMessage) => {
				if (res.statusCode && res.statusCode >= 400) {
					let errBody = "";
					res.on("data", (chunk: Buffer) => (errBody += chunk.toString()));
					res.on("end", () =>
						reject(
							new Error(
								`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`
							)
						)
					);
					return;
				}

				// Wrap the Node readable stream as a Web ReadableStream
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						res.on("data", (chunk: Buffer) => {
							controller.enqueue(new Uint8Array(chunk));
						});
						res.on("end", () => controller.close());
						res.on("error", (err) => controller.error(err));
					},
					cancel() {
						res.destroy();
					},
				});

				resolve(stream.getReader());
			}
		);

		req.on("error", reject);

		if (signal) {
			const onAbort = () => {
				req.destroy();
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			req.on("close", () => signal.removeEventListener("abort", onAbort));
		}

		req.write(JSON.stringify(body));
		req.end();
	});
}

// ── Provider helpers (shared across embed/chat implementations) ────

/** Log embedding HTTP failures with status + body extraction common to requestUrl errors. */
export function logEmbedHttpError(log: Logger, err: unknown): void {
	const errAny = err as Record<string, unknown> | null;
	if (errAny?.status) {
		log.error(
			"embed",
			`Embed HTTP ${errAny.status}`,
			errAny.body ?? errAny.message ?? err,
		);
	}
}

/** Shape of an OpenAI-style /v1/embeddings response (also used by OpenRouter and LM Studio). */
interface OpenAIEmbeddingsResponse {
	data?: Array<{ embedding: number[]; index: number }>;
}

/**
 * Parse an OpenAI-style embeddings response: validates length, sorts by `index`,
 * returns vectors in input order.
 */
export function parseOpenAIEmbeddings(
	data: unknown,
	expectedCount: number,
	providerName: string,
): number[][] {
	const entries = (data as OpenAIEmbeddingsResponse | null)?.data;
	if (!Array.isArray(entries) || entries.length !== expectedCount) {
		throw new Error(`Invalid batch embedding response from ${providerName}`);
	}
	entries.sort((a, b) => a.index - b.index);
	return entries.map((e) => e.embedding);
}

/**
 * Generic OpenAI-style SSE stream consumer (works for `/v1/chat/completions`).
 *
 * Pluggable for the small differences between OpenAI-compat, OpenRouter, and
 * LM Studio's fallback path:
 *   - `reasoningKeys`   → list of `delta.*` keys to read as reasoning text
 *   - `processingOnComment` → emit `onStatus("processing")` on `:` SSE comments
 *   - `initialProcessing`   → emit `onStatus("processing")` before reading
 */
export async function consumeOpenAIStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cb: StreamCallback,
	opts: {
		reasoningKeys?: string[];
		processingOnComment?: boolean;
		initialProcessing?: boolean;
	} = {},
): Promise<ChatStreamResult> {
	const decoder = new TextDecoder();
	const reasoningKeys = opts.reasoningKeys ?? [];
	let buffer = "";
	let accumulated = "";
	let reasoningAccumulated = "";
	let started = false;
	let reasoning = false;
	let stats: ChatStats | null = null;

	if (opts.initialProcessing) cb.onStatus("processing");

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const { events, remainder } = parseSSE(buffer);
			buffer = remainder;

			for (const ev of events) {
				if (opts.processingOnComment && ev.comment !== undefined && ev.data.length === 0) {
					cb.onStatus("processing");
					continue;
				}
				if (isSSEDone(ev.data)) continue;
				if (ev.data.length === 0) continue;

				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(ev.data) as Record<string, unknown>;
				} catch {
					continue;
				}

				const choices = parsed.choices as
					| Array<{ delta?: Record<string, unknown> }>
					| undefined;
				const delta = choices?.[0]?.delta;

				// Reasoning tokens (look up each configured key in delta)
				for (const k of reasoningKeys) {
					const v = delta?.[k];
					if (typeof v === "string" && v.length > 0) {
						if (!reasoning) {
							cb.onStatus("reasoning");
							reasoning = true;
						}
						reasoningAccumulated += v;
						cb.onReasoning?.(reasoningAccumulated);
						break;
					}
				}

				// Content tokens
				const token = delta?.content;
				if (typeof token === "string" && token.length > 0) {
					if (!started) {
						cb.onStatus("generating");
						started = true;
					}
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
			}
		}
	} finally {
		reader.releaseLock();
	}

	cb.onStatus("done");
	return { text: accumulated, stats };
}
