/** A single chunk from a vault page, ready for embedding. */
export interface VaultChunk {
	/** Unique ID: filepath + chunk index */
	id: string;
	/** Source file path (vault-relative) */
	filePath: string;
	pageName: string;
	text: string;
	/** Chunk index within the page (0-based) */
	chunkIndex: number;
}

/** A chunk with its embedding vector attached. */
export interface EmbeddedChunk extends VaultChunk {
	vector: number[];
}

/** Result of a similarity search. */
export interface SearchResult {
	chunk: EmbeddedChunk;
	similarity: number;
}

// ── Endpoint configuration ────────────────────────────────────

/** A custom key-value parameter to pass in the request body. */
export interface CustomParam {
	key: string;
	value: string; // stored as string, parsed to number/boolean/string at request time
}

/** Provider type — determines which native API to use. */
export type ProviderType = "ollama" | "openrouter" | "lmstudio" | "openai-compat";

/** Configuration for a single LLM endpoint (embedding or inference). */
export interface EndpointConfig {
	id: string;
	/** User-friendly label */
	name: string;
	type: "embedding" | "inference";
	/**
	 * Provider type — determines which native API and streaming format to use.
	 * - "ollama"       — Ollama native (NDJSON streaming, /api/*)
	 * - "openrouter"   — OpenRouter (SSE streaming, auth headers, reasoning)
	 * - "lmstudio"     — LM Studio (named SSE events, /api/v1/*)
	 * - "openai-compat" — Generic OpenAI-compatible (/v1/*)
	 */
	providerType: ProviderType;
	/** API key (required for OpenRouter, optional for LM Studio / OpenAI-compat). */
	apiKey?: string;
	/** Base URL, e.g. http://localhost:11434 or http://localhost:1234 */
	url: string;
	/** Model name, e.g. mxbai-embed-large or qwen3.5:9b */
	model: string;

	// ── Common tuning params ─────────────────────────────────
	/** Context window size (num_ctx). If set, sent in options.num_ctx (Ollama) or ignored (OpenAI). */
	contextSize?: number;
	/**
	 * How long to keep the model loaded after a request. Ollama-only.
	 * Ollama duration string: "5m", "1h", "0" (unload immediately), "-1" (forever).
	 * Undefined / "" → Ollama default (usually 5m). Ignored for OpenAI endpoints.
	 */
	keepAlive?: string;

	// ── Inference-specific params ──────────────────────────
	/** Temperature (0–2). Only used for inference endpoints. */
	temperature?: number;
	/**
	 * Thinking / reasoning mode. Controls the `think` field in the Ollama request.
	 * - "off"    → think: false (disable reasoning)
	 * - "on"     → think: true  (enable reasoning, most models)
	 * - "low"    → think: "low"    (gpt-oss only)
	 * - "medium" → think: "medium" (gpt-oss only)
	 * - "high"   → think: "high"   (gpt-oss only)
	 * - undefined / "" → field omitted (model default)
	 * Ignored for OpenAI endpoints.
	 */
	thinkingMode?: "" | "off" | "on" | "low" | "medium" | "high";

	// ── Custom params ─────────────────────────────────────
	/** Arbitrary key-value pairs merged into the request body. */
	customParams: CustomParam[];
}

/** Generate a short random ID for new endpoints. */
export function newEndpointId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/** Default base URL for each provider type. */
export function defaultUrlForProvider(pt: ProviderType): string {
	switch (pt) {
		case "ollama": return "http://localhost:11434";
		case "lmstudio": return "http://localhost:1234";
		case "openrouter": return "https://openrouter.ai/api/v1";
		case "openai-compat": return "http://localhost:8080";
	}
}

/** Create a default endpoint config. */
export function createDefaultEndpoint(
	type: "embedding" | "inference",
	partial?: Partial<EndpointConfig>
): EndpointConfig {
	const providerType = partial?.providerType ?? "ollama";
	return {
		id: newEndpointId(),
		name: partial?.name ?? (type === "embedding" ? "Local Ollama" : "Remote Ollama"),
		type,
		providerType,
		apiKey: partial?.apiKey,
		url: partial?.url ?? defaultUrlForProvider(providerType),
		model: partial?.model ?? (type === "embedding" ? "mxbai-embed-large" : "qwen3.5:9b"),
		contextSize: partial?.contextSize,
		keepAlive: partial?.keepAlive,
		temperature: partial?.temperature,
		thinkingMode: partial?.thinkingMode,
		customParams: partial?.customParams ?? [],
	};
}

/** Plugin settings. */
export interface VasoSettings {
	// ── Endpoints (ordered lists — tried in sequence) ──────
	embeddingEndpoints: EndpointConfig[];
	inferenceEndpoints: EndpointConfig[];

	// ── Retrieval tuning ───────────────────────────────────
	/** L0: Number of paragraph-focused chunks (0 = disabled). Only when cursor available. */
	l0Chunks: number;
	/** L0: How much content to send per match. "chunk" = matched chunk only, "nearby" = ±N surrounding chunks, "page" = full page. */
	l0Depth: "chunk" | "nearby" | "page";
	/** L0: When l0Depth is "nearby", how many chunks before/after the match to include. */
	l0NearbyRadius: number;
	/** L0: Include the paragraphs before and after the cursor paragraph in the L0 query. */
	l0IncludeNeighborParagraphs: boolean;
	/** L1: Number of whole-note relevant chunks whose full pages are sent. */
	l1Chunks: number;
	/** L2: Number of broad-context chunks (text only). */
	l2Chunks: number;
	/** Max words per full page in L1 (truncation limit). */
	l1MaxPageWords: number;

	// ── Chunking ───────────────────────────────────────────
	chunkSize: number;
	/** Overlap in words between chunks. */
	chunkOverlap: number;

	// ── Index scope ────────────────────────────────────────
	/** Whether to index files in the vault root (not in any subdirectory) */
	indexRoot: boolean;
	/** List of directories to index (vault-relative paths) */
	indexedDirectories: string[];

	// ── Prompt ─────────────────────────────────────────────
	/** System prompt sent to the LLM for context synthesis. */
	systemPrompt: string;
	/** Number of words from the current note to include as writing context. 0 = full file. */
	contextWords: number;
	/** Strip YAML frontmatter from content before sending to the LLM. */
	stripFrontmatter: boolean;
	/** Strip Obsidian callout blocks from content before sending to the LLM. */
	stripCallouts: boolean;
	/** Callout types to keep (whitelist). E.g. ["example"]. Case-insensitive. */
	calloutWhitelist: string[];

	// ── Behaviour ──────────────────────────────────────────
	/** Debounce delay in ms before triggering context refresh on edits */
	debounceMs: number;
	/** Debounce delay in ms before triggering context refresh on note switch */
	noteSwitchDebounceMs: number;
	/** Debounce delay in ms before re-indexing changed files (0 = disabled) */
	indexDebounceMs: number;
	contextPanelEnabled: boolean;

	// ── Debug ─────────────────────────────────────────────
	/** Write verbose debug logs to vaso-debug.log in the plugin folder. */
	debugLogging: boolean;
	/** Maximum log file size in MB before rotation. */
	debugLogMaxSizeMB: number;
}

export const DEFAULT_SETTINGS: VasoSettings = {
	embeddingEndpoints: [
		createDefaultEndpoint("embedding", {
			name: "Local Ollama",
			url: "http://localhost:11434",
			model: "mxbai-embed-large",
		}),
	],
	inferenceEndpoints: [
		createDefaultEndpoint("inference", {
			name: "Local Ollama",
			url: "http://localhost:11434",
			model: "qwen3.5:9b",
			temperature: 0.7,
		}),
	],

	l0Chunks: 3,
	l0Depth: "chunk",
	l0NearbyRadius: 2,
	l0IncludeNeighborParagraphs: true,
	l1Chunks: 3,
	l2Chunks: 4,
	l1MaxPageWords: 800,

	chunkSize: 300,
	chunkOverlap: 50,

	indexRoot: false,
	indexedDirectories: [],

	systemPrompt: `You are a lore assistant for a worldbuilding vault. The user is writing content and you need to surface the most relevant established facts.

Given the user's current writing and the lore excerpts below, provide 3-6 concise bullet points of established facts most relevant to what they're writing. Flag any potential contradictions with existing lore. Be concise and specific — cite page names in parentheses.

Do not add preamble or explanation. Just the bullet points.`,

	contextWords: 300,
	stripFrontmatter: true,
	stripCallouts: true,
	calloutWhitelist: ["example"],

	debounceMs: 2000,
	noteSwitchDebounceMs: 3000,
	indexDebounceMs: 10000,
	contextPanelEnabled: true,

	debugLogging: false,
	debugLogMaxSizeMB: 2,
};
