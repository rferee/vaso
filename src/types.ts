import type { Vector } from "./vectors";

/** A single chunk from a vault page, ready for embedding. */
export interface VaultChunk {
	/** Source file path (vault-relative) */
	filePath: string;
	pageName: string;
	text: string;
	/** Chunk index within the page (0-based) */
	chunkIndex: number;
}

/** A chunk with its unit-length embedding vector attached. */
export interface EmbeddedChunk extends VaultChunk {
	vector: Vector;
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
	value: string; // stored as string, parsed to number/boolean/JSON/string at request time
}

/** Provider type — determines which native API to use. */
export type ProviderType = "ollama" | "openrouter" | "lmstudio" | "openai-compat";

export type EndpointKind = "embedding" | "inference";

export type ThinkingMode = "" | "off" | "on" | "low" | "medium" | "high";

/** Configuration for a single LLM endpoint (embedding or inference). */
export interface EndpointConfig {
	id: string;
	/** User-friendly label */
	name: string;
	type: EndpointKind;
	/**
	 * - "ollama"        — Ollama native API (/api/*, NDJSON streaming)
	 * - "openrouter"    — OpenRouter (SSE streaming, API key, reasoning effort)
	 * - "lmstudio"      — LM Studio native API (/api/v1/*) with /v1/* fallback
	 * - "openai-compat" — Generic OpenAI-compatible server (/v1/*)
	 */
	providerType: ProviderType;
	/** API key (required for OpenRouter, optional elsewhere). */
	apiKey?: string;
	/** Base URL, e.g. http://localhost:11434 */
	url: string;
	/** Model name, e.g. mxbai-embed-large or qwen3.5:9b */
	model: string;

	/** Context window. Ollama: options.num_ctx; LM Studio: load-time context_length. */
	contextSize?: number;
	/**
	 * How long Ollama keeps the model loaded after a request: "5m", "1h",
	 * "0" (unload immediately), "-1" (forever). Empty → Ollama default.
	 */
	keepAlive?: string;

	/** Temperature (0–2). Inference only. */
	temperature?: number;
	/**
	 * Reasoning control. Ollama: `think`; OpenRouter: `reasoning.effort`;
	 * LM Studio: `reasoning`. Empty → omitted (model default).
	 */
	thinkingMode?: ThinkingMode;

	/** Arbitrary key-value pairs merged into the request body. */
	customParams: CustomParam[];
}

export function newEndpointId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export const PROVIDER_LABELS: Record<ProviderType, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	openrouter: "OpenRouter",
	"openai-compat": "OpenAI-compatible",
};

/** Default base URL for each provider type. */
export function defaultUrlForProvider(pt: ProviderType): string {
	switch (pt) {
		case "ollama": return "http://localhost:11434";
		case "lmstudio": return "http://localhost:1234";
		case "openrouter": return "https://openrouter.ai/api/v1";
		case "openai-compat": return "http://localhost:8080";
	}
}

export function defaultModelFor(type: EndpointKind): string {
	return type === "embedding" ? "mxbai-embed-large" : "qwen3.5:9b";
}

/** Create an endpoint config, filling anything `partial` leaves out. */
export function createDefaultEndpoint(
	type: EndpointKind,
	partial: Partial<EndpointConfig> = {},
): EndpointConfig {
	const providerType = partial.providerType ?? "ollama";
	return {
		id: partial.id ?? newEndpointId(),
		name: partial.name ?? PROVIDER_LABELS[providerType],
		type,
		providerType,
		apiKey: partial.apiKey,
		url: partial.url ?? defaultUrlForProvider(providerType),
		model: partial.model ?? defaultModelFor(type),
		contextSize: partial.contextSize,
		keepAlive: partial.keepAlive,
		temperature: partial.temperature,
		thinkingMode: partial.thinkingMode,
		customParams: Array.isArray(partial.customParams) ? partial.customParams : [],
	};
}

// ── Plugin settings ───────────────────────────────────────────

export type L0Depth = "chunk" | "nearby" | "page";

export interface VasoSettings {
	// ── Endpoints (ordered lists — tried in sequence) ──────
	embeddingEndpoints: EndpointConfig[];
	inferenceEndpoints: EndpointConfig[];

	// ── Retrieval tuning ───────────────────────────────────
	/** L0: Number of paragraph-focused chunks (0 = disabled). Only when cursor available. */
	l0Chunks: number;
	/** L0: "chunk" = matched chunk only, "nearby" = ±N surrounding chunks, "page" = full page. */
	l0Depth: L0Depth;
	/** L0: When l0Depth is "nearby", how many chunks before/after the match to include. */
	l0NearbyRadius: number;
	/** L0: Include the paragraphs before and after the cursor paragraph in the L0 query. */
	l0IncludeNeighborParagraphs: boolean;
	/** L1: Number of whole-note relevant pages whose full content is sent. */
	l1Chunks: number;
	/** L2: Number of broad-context chunks (text only). */
	l2Chunks: number;
	/** Max words per full page (L1, and L0 at page depth). */
	l1MaxPageWords: number;

	// ── Chunking ───────────────────────────────────────────
	chunkSize: number;
	/** Overlap in words between chunks (always below chunkSize). */
	chunkOverlap: number;

	// ── Index scope ────────────────────────────────────────
	/** Index files in the vault root (not in any folder). */
	indexRoot: boolean;
	/** Folders to index (vault-relative paths). */
	indexedDirectories: string[];

	// ── Prompt ─────────────────────────────────────────────
	/** System prompt sent to the LLM for context synthesis. */
	systemPrompt: string;
	/** User message template; see renderTemplate() in prompt-builder.ts. */
	userPromptTemplate: string;
	/** Number of words from the current note to include as writing context. 0 = full file. */
	contextWords: number;
	stripFrontmatter: boolean;
	stripCallouts: boolean;
	/** Callout types to keep when stripping (case-insensitive). */
	calloutWhitelist: string[];

	// ── Behaviour ──────────────────────────────────────────
	/** Delay after the last edit before refreshing the panel. */
	debounceMs: number;
	/** Delay after switching notes before refreshing the panel. */
	noteSwitchDebounceMs: number;
	/** Delay before re-indexing changed files (0 = no automatic index updates). */
	indexDebounceMs: number;
	contextPanelEnabled: boolean;

	// ── Debug ─────────────────────────────────────────────
	debugLogging: boolean;
	debugLogMaxSizeMB: number;
}

export const DEFAULT_SYSTEM_PROMPT = `You are a lore assistant for a worldbuilding vault. The user is writing content and you need to surface the most relevant established facts.

Given the user's current writing and the lore excerpts below, provide 3-6 concise bullet points of established facts most relevant to what they're writing. Flag any potential contradictions with existing lore. Be concise and specific — cite page names in parentheses.

Do not add preamble or explanation. Just the bullet points.`;

export const DEFAULT_USER_PROMPT_TEMPLATE = `{{#paragraph}}
## Paragraph the user is currently editing:
**{{paragraph}}**
{{/paragraph}}

## Writing context:
{{writing}}

{{#l0}}
## Most relevant lore (paragraph-matched):
{{l0}}
{{/l0}}

{{#l1}}
## Lore pages (note-matched):
{{l1}}
{{/l1}}

{{#l2}}
## Additional lore excerpts:
{{l2}}
{{/l2}}`;

export const DEFAULT_SETTINGS: Readonly<VasoSettings> = {
	embeddingEndpoints: [
		createDefaultEndpoint("embedding", { id: "default-embed", name: "Local Ollama" }),
	],
	inferenceEndpoints: [
		createDefaultEndpoint("inference", { id: "default-infer", name: "Local Ollama", temperature: 0.7 }),
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

	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE,
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

/**
 * Merge saved data over fresh defaults. Never hands out references into
 * DEFAULT_SETTINGS, fills fields missing from older saves, and clamps values
 * the code relies on (e.g. chunk overlap below chunk size).
 */
export function normalizeSettings(data: unknown): VasoSettings {
	const defaults = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as VasoSettings;
	const saved = (typeof data === "object" && data !== null ? data : {}) as Partial<VasoSettings>;
	const s: VasoSettings = { ...defaults, ...saved };

	const endpoints = (list: unknown, type: EndpointKind, fallback: EndpointConfig[]) =>
		Array.isArray(list)
			? list
				.filter((e): e is Partial<EndpointConfig> => typeof e === "object" && e !== null)
				.map((e) => createDefaultEndpoint(type, { ...e, type }))
			: fallback;
	s.embeddingEndpoints = endpoints(saved.embeddingEndpoints, "embedding", defaults.embeddingEndpoints);
	s.inferenceEndpoints = endpoints(saved.inferenceEndpoints, "inference", defaults.inferenceEndpoints);

	const strings = (v: unknown, fallback: string[]) =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
	s.indexedDirectories = strings(saved.indexedDirectories, defaults.indexedDirectories);
	s.calloutWhitelist = strings(saved.calloutWhitelist, defaults.calloutWhitelist);

	const int = (v: number, min: number, max: number, fallback: number) =>
		Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
	s.chunkSize = int(s.chunkSize, 50, 4000, defaults.chunkSize);
	s.chunkOverlap = int(s.chunkOverlap, 0, s.chunkSize - 1, defaults.chunkOverlap);
	s.l0Chunks = int(s.l0Chunks, 0, 50, defaults.l0Chunks);
	s.l0NearbyRadius = int(s.l0NearbyRadius, 1, 10, defaults.l0NearbyRadius);
	s.l1Chunks = int(s.l1Chunks, 0, 50, defaults.l1Chunks);
	s.l2Chunks = int(s.l2Chunks, 0, 50, defaults.l2Chunks);
	s.l1MaxPageWords = int(s.l1MaxPageWords, 50, 20000, defaults.l1MaxPageWords);
	s.contextWords = int(s.contextWords, 0, 20000, defaults.contextWords);
	s.debounceMs = int(s.debounceMs, 0, 60000, defaults.debounceMs);
	s.noteSwitchDebounceMs = int(s.noteSwitchDebounceMs, 0, 60000, defaults.noteSwitchDebounceMs);
	s.indexDebounceMs = int(s.indexDebounceMs, 0, 600000, defaults.indexDebounceMs);
	s.debugLogMaxSizeMB = int(s.debugLogMaxSizeMB, 1, 100, defaults.debugLogMaxSizeMB);
	if (!["chunk", "nearby", "page"].includes(s.l0Depth)) s.l0Depth = defaults.l0Depth;
	if (typeof s.systemPrompt !== "string") s.systemPrompt = defaults.systemPrompt;
	if (typeof s.userPromptTemplate !== "string" || s.userPromptTemplate.trim() === "") {
		s.userPromptTemplate = defaults.userPromptTemplate;
	}
	return s;
}
