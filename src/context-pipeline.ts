import type { App, Editor, TFile } from "obsidian";
import type { EndpointConfig, VasoSettings } from "./types";
import type { ChatMessage } from "./llm";
import { embedQuery, embedTexts, resolveEmbeddingEndpoint } from "./llm";
import type { VaultIndex } from "./indexer";
import { indexMismatch, isFileInScope } from "./indexer";
import { threeLayerSearch } from "./search";
import type { ThreeLayerResult } from "./search";
import {
	buildChunkContext,
	buildFullPageContext,
	buildL0Context,
	buildCacheKey,
	buildMessages,
} from "./prompt-builder";
import type { PromptVars } from "./prompt-builder";
import type { LLMCache } from "./llm-cache";
import {
	chunkText,
	cleanContent,
	frontmatterLength,
	hashString,
	lastWords,
	splitParagraphs,
	truncate,
} from "./text";
import type { Vector } from "./vectors";
import { getLogger } from "./logger";

/** Status updates while the pipeline runs (drives the panel's activity line). */
export interface PipelineProgress {
	embeddingParagraph(): void;
	embeddingNote(): void;
	searching(): void;
	readingPages(): void;
}

/** What the view should render. */
export type PipelineRun =
	| { kind: "tooShort" }
	| { kind: "noIndex" }
	| { kind: "indexProblem"; message: string }
	| { kind: "skipped" }
	| { kind: "noMatches" }
	| { kind: "cached"; response: string; sources: ThreeLayerResult }
	| { kind: "ready"; messages: ChatMessage[]; sources: ThreeLayerResult; cacheKey: string };

export interface RunOptions {
	force: boolean;
	signal: AbortSignal;
	/** Input key of the previous run; an unchanged key skips the run. */
	prevInputKey: string;
}

export interface RunResult {
	run: PipelineRun;
	/** Fingerprint of everything this run read; the view passes it back as prevInputKey. */
	inputKey: string;
}

interface CursorContext {
	/** Text embedded for L0: the cursor paragraph, optionally with its neighbours. */
	query: string;
	paragraph: string;
}

export class ContextPipeline {
	/** Vectors of the current note's chunks, reused while the note and model stay the same. */
	private noteVecs = new Map<string, Vector>();
	private noteVecsOwner = "";

	constructor(
		private app: App,
		private cache: LLMCache,
		private getSettings: () => VasoSettings,
	) {}

	storeResponse(filePath: string, cacheKey: string, response: string): void {
		this.cache.set(filePath, cacheKey, response);
		void this.cache.save();
	}

	async prepare(
		file: TFile,
		editor: Editor | undefined,
		index: VaultIndex | null,
		opts: RunOptions,
		progress: PipelineProgress,
	): Promise<RunResult> {
		const settings = this.getSettings();
		const log = getLogger();

		const rawText = editor ? editor.getValue() : await this.app.vault.cachedRead(file);
		const fullText = cleanContent(rawText, settings);
		if (fullText.trim().length < 20) return { run: { kind: "tooShort" }, inputKey: "" };

		const cursor = extractCursorContext(editor, rawText, settings);
		const inputKey = hashString(
			[file.path, fullText, cursor?.query ?? "", JSON.stringify(settings)].join("\u0000"),
		);
		if (!opts.force && inputKey === opts.prevInputKey) {
			return { run: { kind: "skipped" }, inputKey };
		}

		if (!index || index.chunks.length === 0) return { run: { kind: "noIndex" }, inputKey };
		// Notes taken out of the index scope keep their chunks until the next
		// update; they must not be retrieved and sent to the LLM in the meantime.
		const chunks = index.chunks.filter((c) => isFileInScope(c.filePath, settings));
		if (chunks.length === 0) return { run: { kind: "noMatches" }, inputKey };
		const ep = await resolveEmbeddingEndpoint(settings);
		opts.signal.throwIfAborted();
		const mismatch = indexMismatch(index, settings, ep.model);
		if (mismatch) {
			return { run: { kind: "indexProblem", message: `${mismatch} Rebuild the index.` }, inputKey };
		}

		// ── L0: cursor paragraph ──
		let l0Vec: Vector | null = null;
		if (cursor && settings.l0Chunks > 0) {
			progress.embeddingParagraph();
			log.debug("context", `L0 query: "${truncate(cursor.query, 200)}"`);
			l0Vec = await embedQuery(ep, cursor.query, opts.signal);
		}

		// ── L1/L2: the whole note ──
		progress.embeddingNote();
		const noteChunks = chunkText(fullText, settings.chunkSize, settings.chunkOverlap);
		const noteVecs = await this.embedNoteChunks(ep, file.path, noteChunks, opts.signal);

		progress.searching();
		const sources = threeLayerSearch(
			l0Vec,
			noteVecs,
			chunks,
			{ l0: settings.l0Chunks, l1: settings.l1Chunks, l2: settings.l2Chunks },
			file.path,
		);
		if (sources.l0.length + sources.l1.length + sources.l2.length === 0) {
			return { run: { kind: "noMatches" }, inputKey };
		}

		// ── Prompt ──
		progress.readingPages();
		const vars: PromptVars = {
			title: file.basename,
			paragraph: cursor?.paragraph ?? "",
			writing: lastWords(fullText, settings.contextWords),
			l0: await buildL0Context(sources.l0, this.app, settings, chunks),
			l1: await buildFullPageContext(sources.l1, this.app, settings),
			l2: buildChunkContext(sources.l2),
		};

		const cacheKey = buildCacheKey(settings, vars);
		const cached = this.cache.get(file.path, cacheKey);
		opts.signal.throwIfAborted();
		if (!opts.force && cached) {
			return { run: { kind: "cached", response: cached, sources }, inputKey };
		}

		const messages = buildMessages(settings.systemPrompt, settings.userPromptTemplate, vars);
		return { run: { kind: "ready", messages, sources, cacheKey }, inputKey };
	}

	/** Embed the note's chunks, reusing vectors of chunks whose text didn't change. */
	private async embedNoteChunks(
		ep: EndpointConfig,
		filePath: string,
		texts: string[],
		signal: AbortSignal,
	): Promise<Vector[]> {
		const owner = `${filePath}\u0000${ep.model}`;
		const known = owner === this.noteVecsOwner ? this.noteVecs : new Map<string, Vector>();
		const missing = [...new Set(texts.filter((t) => !known.has(t)))];

		if (missing.length > 0) {
			getLogger().debug("context", `Note chunks: ${texts.length} total, ${missing.length} to embed`);
			const vecs = await embedTexts(ep, missing, signal);
			missing.forEach((t, i) => {
				const v = vecs[i];
				if (v) known.set(t, v);
			});
		}

		const next = new Map<string, Vector>();
		const out: Vector[] = [];
		for (const t of texts) {
			const v = known.get(t);
			if (!v) continue;
			next.set(t, v);
			out.push(v);
		}
		this.noteVecs = next;
		this.noteVecsOwner = owner;
		return out;
	}
}

/**
 * The cleaned paragraph under the cursor, plus its neighbours when enabled.
 * Offsets come from the raw text so the lookup matches the editor; paragraphs
 * inside stripped frontmatter or callouts are dropped.
 */
function extractCursorContext(
	editor: Editor | undefined,
	rawText: string,
	settings: VasoSettings,
): CursorContext | null {
	if (!editor) return null;
	const paragraphs = splitParagraphs(rawText);
	if (paragraphs.length === 0) return null;

	const offset = editor.posToOffset(editor.getCursor());
	let idx = paragraphs.findIndex((p) => offset >= p.start && offset <= p.end);
	if (idx === -1) idx = paragraphs.length - 1;

	const fmEnd = settings.stripFrontmatter ? frontmatterLength(rawText) : 0;
	const clean = (i: number): string => {
		const p = paragraphs[i];
		if (!p || p.end <= fmEnd) return "";
		const text = rawText.slice(Math.max(p.start, fmEnd), p.end);
		return cleanContent(text, { ...settings, stripFrontmatter: false }).trim();
	};

	const paragraph = clean(idx);
	if (!paragraph) return null;

	const parts = settings.l0IncludeNeighborParagraphs
		? [clean(idx - 1), paragraph, clean(idx + 1)]
		: [paragraph];
	return { query: parts.filter((p) => p.length > 0).join("\n\n"), paragraph };
}
