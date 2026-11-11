import { Platform, requestUrl } from "obsidian";
import type * as NodeHttp from "http";
import type { CustomParam, EndpointConfig } from "../types";
import { abortError, raceAbort } from "../errors";
import { getLogger } from "../logger";
import { parseSSE, isSSEDone } from "./parse-sse";
import type { ChatStats, ChatStreamResult, StreamCallback } from "./types";

// ── Custom params ───────────────────────────────────────────────

/** Parse a CustomParam string value: booleans, numbers and JSON objects/arrays; anything else stays a string. */
export function parseParamValue(v: string): unknown {
	const t = v.trim();
	if (t === "true") return true;
	if (t === "false") return false;
	if (t.length > 0 && !isNaN(Number(t))) return Number(t);
	if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
		try {
			return JSON.parse(t);
		} catch { /* keep as string */ }
	}
	return v;
}

/** Custom params as a flat object; an "options." prefix (Ollama convention) is dropped. */
export function customParamsFlat(params: CustomParam[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const p of params) {
		let key = p.key.trim();
		if (!key) continue;
		if (key.startsWith("options.")) key = key.slice("options.".length);
		out[key] = parseParamValue(p.value);
	}
	return out;
}

/** Custom params split Ollama-style: "options.x" keys go into `options`, the rest top-level. */
export function customParamsOllama(params: CustomParam[]): {
	top: Record<string, unknown>;
	options: Record<string, unknown>;
} {
	const top: Record<string, unknown> = {};
	const options: Record<string, unknown> = {};
	for (const p of params) {
		const key = p.key.trim();
		if (!key) continue;
		if (key.startsWith("options.")) options[key.slice("options.".length)] = parseParamValue(p.value);
		else top[key] = parseParamValue(p.value);
	}
	return { top, options };
}

// ── Requests ────────────────────────────────────────────────────

export function buildHeaders(ep: EndpointConfig, extra: Record<string, string> = {}): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
	if (ep.apiKey) headers["Authorization"] = `Bearer ${ep.apiKey}`;
	return headers;
}

export function joinUrl(base: string, path: string): string {
	return base.replace(/\/+$/, "") + path;
}

/** The URL without the user name and password it may carry, for logs and the UI. */
export function redactUrl(url: string): string {
	try {
		const u = new URL(url);
		if (u.host) {
			if (!u.username && !u.password) return url;
			u.username = "";
			u.password = "";
			return u.toString();
		}
	} catch { /* not a URL: strip by hand */ }
	return url.replace(/^([^/?#@]*\/\/)?[^/?#]*@/, "$1");
}

/** An HTTP error status, with the start of the response body for context. */
export class HttpError extends Error {
	constructor(
		public status: number,
		body: string,
	) {
		super(`HTTP ${status}${body.trim() ? `: ${extractErrorText(body).slice(0, 300)}` : ""}`);
		this.name = "HttpError";
	}
}

/** Pull `error.message` / `error` out of a JSON error body when there is one. */
function extractErrorText(body: string): string {
	try {
		const j = JSON.parse(body) as { error?: unknown; message?: unknown };
		const e = j.error;
		if (typeof e === "string") return e;
		if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
		if (typeof j.message === "string") return j.message;
	} catch { /* not JSON */ }
	return body;
}

/**
 * JSON request via Obsidian's requestUrl, which is not subject to CORS on
 * desktop or mobile. Throws HttpError on error statuses.
 */
export async function requestJson(
	url: string,
	opts: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> } = {},
): Promise<unknown> {
	const resp = await requestUrl({
		url,
		method: opts.method ?? "GET",
		headers: opts.headers ?? { "Content-Type": "application/json" },
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		throw: false,
	});
	if (resp.status >= 400) throw new HttpError(resp.status, resp.text);
	return resp.json as unknown;
}

/** A count from a server response, such as a context length: a positive integer, else undefined (JSON reads 1e309 as Infinity). */
export function positiveInt(v: unknown): number | undefined {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

// ── Streaming ───────────────────────────────────────────────────

type Reader = ReadableStreamDefaultReader<Uint8Array>;

/** Origins that refused a browser fetch but answered requestUrl (CORS): stream buffered from then on. */
const bufferedOrigins = new Set<string>();

/**
 * Streaming POST that works on every platform.
 *
 * - Desktop: Node's http/https, which has no CORS restrictions.
 * - Mobile: browser fetch with a streamed body. Servers must allow the app's
 *   origin (CORS) for this; when they don't, the request is repeated through
 *   requestUrl and the whole response arrives at once, so answers appear
 *   without live streaming instead of failing.
 */
export async function fetchStream(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Reader> {
	signal?.throwIfAborted();
	if (Platform.isDesktopApp) return nodeStream(url, body, headers, signal);

	const origin = new URL(url).origin;
	if (!bufferedOrigins.has(origin)) {
		try {
			return await browserStream(url, body, headers, signal);
		} catch (err) {
			if (signal?.aborted || err instanceof HttpError) throw err;
			getLogger().warn("infer", `Streaming fetch to ${origin} failed (CORS?), retrying without streaming`, err);
		}
		const reader = await bufferedStream(url, body, headers, signal);
		bufferedOrigins.add(origin);
		return reader;
	}
	return bufferedStream(url, body, headers, signal);
}

async function browserStream(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Reader> {
	const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
	if (!resp.ok) throw new HttpError(resp.status, await resp.text().catch(() => ""));
	if (!resp.body) throw new Error("Response has no readable body");
	return resp.body.getReader();
}

/** requestUrl can't stream or be cancelled; abort rejects and the late result is dropped. */
async function bufferedStream(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Reader> {
	const resp = await raceAbort(
		requestUrl({ url, method: "POST", headers, body: JSON.stringify(body), throw: false }),
		signal,
	);
	if (resp.status >= 400) throw new HttpError(resp.status, resp.text);
	const bytes = new Uint8Array(resp.arrayBuffer);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	}).getReader();
}

/** Node http/https, loaded lazily so the module never touches Node APIs on mobile. */
function nodeStream(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Reader> {
	if (!Platform.isDesktopApp) throw new Error("Node streaming is only available on desktop");
	const mod = (url.startsWith("https:") ? require("https") : require("http")) as typeof NodeHttp;

	return new Promise((resolve, reject) => {
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		let finished = false;
		const finish = (err?: unknown) => {
			if (finished) return;
			finished = true;
			signal?.removeEventListener("abort", onAbort);
			if (err !== undefined) {
				controller?.error(err);
				reject(err);
			} else {
				controller?.close();
			}
		};
		const onAbort = () => {
			req.destroy();
			finish(abortError(signal));
		};

		const req = mod.request(url, { method: "POST", headers }, (res) => {
			if (res.statusCode && res.statusCode >= 400) {
				let errBody = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => (errBody += c));
				res.on("end", () => finish(new HttpError(res.statusCode ?? 0, errBody)));
				res.on("error", (err) => finish(err));
				return;
			}
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					res.on("data", (chunk: Uint8Array) => {
						if (!finished) c.enqueue(new Uint8Array(chunk));
					});
					res.on("end", () => finish());
					res.on("error", (err) => finish(signal?.aborted ? abortError(signal) : err));
					res.on("close", () => finish(res.complete ? undefined : new Error("Connection closed early")));
				},
				cancel() {
					finished = true;
					signal?.removeEventListener("abort", onAbort);
					res.destroy();
				},
			});
			resolve(stream.getReader());
		});

		signal?.addEventListener("abort", onAbort, { once: true });
		req.on("error", (err) => finish(signal?.aborted ? abortError(signal) : err));
		req.end(JSON.stringify(body));
	});
}

// ── Stream consumers ────────────────────────────────────────────

/** Feed decoded text chunks to `onText`; always releases the reader. */
export async function readText(reader: Reader, onText: (text: string) => void): Promise<void> {
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			onText(decoder.decode(value, { stream: true }));
		}
		onText(decoder.decode());
	} finally {
		reader.releaseLock();
	}
}

/** Text of an OpenRouter `reasoning_details` array (summary or text entries). */
function reasoningDetailsText(details: unknown): string {
	if (!Array.isArray(details)) return "";
	return details
		.map((d: { text?: unknown; summary?: unknown }) =>
			typeof d?.text === "string" ? d.text : typeof d?.summary === "string" ? d.summary : "",
		)
		.join("");
}

/**
 * OpenAI-style `/chat/completions` SSE consumer, shared by OpenAI-compatible
 * servers, OpenRouter and LM Studio's fallback path.
 *
 * - `reasoningKeys`: `delta.*` keys carrying reasoning text (first match wins)
 * - `processingOnComment`: `:` comment lines mean "processing" (OpenRouter)
 * - `initialProcessing`: report "processing" before the first byte
 */
export async function consumeOpenAIStream(
	reader: Reader,
	cb: StreamCallback,
	opts: { reasoningKeys?: string[]; processingOnComment?: boolean; initialProcessing?: boolean } = {},
): Promise<ChatStreamResult> {
	const reasoningKeys = opts.reasoningKeys ?? [];
	let buffer = "";
	let text = "";
	let reasoning = "";
	let stats: ChatStats | null = null;
	let phase: "none" | "reasoning" | "generating" = "none";

	if (opts.initialProcessing) cb.onStatus("processing");

	const handle = (data: string) => {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}
		if (parsed.error) {
			const e = parsed.error as { message?: unknown };
			throw new Error(typeof e === "object" && e?.message ? String(e.message) : JSON.stringify(e));
		}

		const choices = parsed.choices as Array<{ delta?: Record<string, unknown> }> | undefined;
		const delta = choices?.[0]?.delta;

		let r = "";
		for (const k of reasoningKeys) {
			const v = delta?.[k];
			if (typeof v === "string" && v.length > 0) {
				r = v;
				break;
			}
		}
		if (!r) r = reasoningDetailsText(delta?.reasoning_details);
		if (r) {
			if (phase === "none") {
				cb.onStatus("reasoning");
				phase = "reasoning";
			}
			reasoning += r;
			cb.onReasoning?.(reasoning);
		}

		const token = delta?.content;
		if (typeof token === "string" && token.length > 0) {
			if (phase !== "generating") {
				cb.onStatus("generating");
				phase = "generating";
			}
			text += token;
			cb.onChunk(text);
		}

		const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
		if (usage && typeof usage.prompt_tokens === "number") {
			stats = {
				promptTokens: usage.prompt_tokens,
				responseTokens: usage.completion_tokens ?? 0,
				totalDurationMs: 0,
			};
		}
	};

	await readText(reader, (chunk) => {
		buffer += chunk;
		const { events, remainder } = parseSSE(buffer);
		buffer = remainder;
		for (const ev of events) {
			if (opts.processingOnComment && ev.comment !== undefined && ev.data.length === 0) {
				cb.onStatus("processing");
				continue;
			}
			if (ev.data.length === 0 || isSSEDone(ev.data)) continue;
			handle(ev.data);
		}
	});
	// A final event without the trailing blank line (common in buffered responses).
	const tail = parseSSE(buffer + "\n\n").events;
	for (const ev of tail) if (ev.data && !isSSEDone(ev.data)) handle(ev.data);

	cb.onStatus("done");
	return { text, stats };
}
