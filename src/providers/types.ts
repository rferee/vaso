import type { EndpointConfig } from "../types";

/** Phase of a streaming response (drives the panel's status line). */
export type StreamPhase =
	| "loading" // model being loaded (LM Studio)
	| "processing" // prompt being processed (LM Studio, OpenRouter)
	| "reasoning" // thinking tokens arriving
	| "generating" // answer tokens arriving
	| "done";

export interface StreamCallback {
	onStatus(phase: StreamPhase, detail?: string): void;
	/** New answer text; `accumulated` is everything so far. */
	onChunk(accumulated: string): void;
	/** New reasoning text; `accumulated` is everything so far. */
	onReasoning?(accumulated: string): void;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatStats {
	promptTokens: number;
	responseTokens: number;
	totalDurationMs: number;
}

export interface ChatStreamResult {
	text: string;
	stats: ChatStats | null;
}

/** Model list entry, normalised across providers. */
export interface ModelEntry {
	id: string;
	name: string;
	ownedBy?: string;
	contextLength?: number;
	parameterSize?: string;
	/** What the model is for, when the provider says. */
	kind?: "llm" | "embedding";
}

/** Detailed model info (Ollama /api/show, LM Studio /api/v1/models). */
export interface ModelInfo {
	/** Model defaults as reported by the server (shown, never sent). */
	parameters: { key: string; value: string }[];
	capabilities: string[];
	contextLength?: number;
	family?: string;
	parameterSize?: string;
	quantization?: string;
}

/**
 * Stateless provider — one singleton per provider type; every call gets the
 * endpoint config.
 */
export interface LLMProvider {
	/** Throws when the endpoint is unreachable or rejects us. */
	healthCheck(ep: EndpointConfig): Promise<void>;
	listModels(ep: EndpointConfig): Promise<ModelEntry[]>;
	/** Detailed info, or null when the provider doesn't expose it. */
	showModel(ep: EndpointConfig, modelName: string): Promise<ModelInfo | null>;
	/** One vector per text, in input order. */
	embedBatch(ep: EndpointConfig, texts: string[]): Promise<number[][]>;
	chatStream(
		ep: EndpointConfig,
		messages: ChatMessage[],
		cb: StreamCallback,
		signal?: AbortSignal,
	): Promise<ChatStreamResult>;
	/** Unload every loaded model; returns the count. */
	unloadAllModels?(ep: EndpointConfig): Promise<number>;
}
