import type { EndpointConfig } from "../types";

// ── Stream status ───────────────────────────────────────────────

/** Phase of a streaming inference response (drives sidebar status display). */
export type StreamPhase =
	| "loading"      // Model being loaded into memory (LM Studio)
	| "processing"   // Prompt being processed (LM Studio, OpenRouter)
	| "reasoning"    // Thinking / chain-of-thought (Ollama, OpenRouter, LM Studio)
	| "generating"   // Content tokens arriving (all providers)
	| "done";

/** Callback for streaming chat responses. */
export interface StreamCallback {
	/** Status phase changed (drives sidebar activity indicator). */
	onStatus(phase: StreamPhase, detail?: string): void;
	/** New content arrived — `accumulated` is the full text so far. */
	onChunk(accumulated: string): void;
	/** Reasoning/thinking token arrived — `accumulated` is the full reasoning so far. */
	onReasoning?(accumulated: string): void;
}

// ── Chat types ──────────────────────────────────────────────────

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

// ── Model types ─────────────────────────────────────────────────

/** Unified model entry (normalised across all provider APIs). */
export interface ModelEntry {
	/** Model identifier (e.g. "qwen3.5:9b", "gpt-4o", "meta-llama/llama-3-8b"). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** Provider or owner string (e.g. "library", "openai", "meta-llama"). */
	ownedBy?: string;
	/** Max context length in tokens, if known. */
	contextLength?: number;
	/** Human-readable parameter size (e.g. "9.2B"). */
	parameterSize?: string;
}

/** Detailed model info (Ollama /api/show, LM Studio /api/v0/models, etc.). */
export interface ModelInfo {
	parameters: { key: string; value: string }[];
	capabilities: string[];
	contextLength?: number;
	parameterCount?: number;
	details: {
		format: string;
		family: string;
		families?: string[];
		parameter_size: string;
		quantization_level: string;
	};
}

// ── Provider interface ──────────────────────────────────────────

/**
 * Stateless LLM provider — one singleton instance per provider type.
 * Every method receives the EndpointConfig so the provider holds no state.
 */
export interface LLMProvider {
	/** Check if the endpoint is reachable. Throws on failure. */
	healthCheck(ep: EndpointConfig): Promise<void>;

	/** List available models. */
	listModels(ep: EndpointConfig): Promise<ModelEntry[]>;

	/** Get detailed model info. Returns null if not supported by this provider. */
	showModel(ep: EndpointConfig, modelName: string): Promise<ModelInfo | null>;

	/** Embed a batch of texts, returning one vector per text. */
	embedBatch(ep: EndpointConfig, texts: string[]): Promise<number[][]>;

	/** Non-streaming chat completion. */
	chat(ep: EndpointConfig, messages: ChatMessage[]): Promise<string>;

	/** Streaming chat completion with status callbacks. */
	chatStream(
		ep: EndpointConfig,
		messages: ChatMessage[],
		cb: StreamCallback,
		signal?: AbortSignal
	): Promise<ChatStreamResult>;

	/** Unload all loaded models. Returns the count of models unloaded, or null if not supported. */
	unloadAllModels?(ep: EndpointConfig): Promise<number | null>;
}
