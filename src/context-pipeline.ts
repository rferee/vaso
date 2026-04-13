import type { App, Editor, TFile } from "obsidian";
import type { VasoSettings, SearchResult } from "./types";
import type { ChatMessage } from "./llm";
import { embed, embedBatch } from "./llm";
import { chunkText } from "./indexer";
import { threeLayerSearch } from "./search";
import type { ThreeLayerResult } from "./search";
import {
	cleanContent,
	buildChunkContext,
	buildFullPageContext,
	buildL0Context,
	buildCacheKey,
	buildMessages,
} from "./prompt-builder";
import type { LLMCache } from "./llm-cache";
import { getLogger } from "./logger";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Split text into paragraphs (blocks separated by blank lines).
 * Returns objects with text and char offsets so cursor lookups stay accurate
 * even when paragraphs repeat verbatim.
 */
function splitParagraphs(text: string): { text: string; start: number; end: number }[] {
	const paragraphs: { text: string; start: number; end: number }[] = [];
	const sepRe = /\n\s*\n/g;
	let lastEnd = 0;
	let m: RegExpExecArray | null;

	while ((m = sepRe.exec(text)) !== null) {
		const part = text.slice(lastEnd, m.index);
		const trimmed = part.trim();
		if (trimmed.length > 0) {
			paragraphs.push({ text: trimmed, start: lastEnd, end: m.index });
		}
		lastEnd = m.index + m[0].length;
	}

	const tail = text.slice(lastEnd);
	const trimmedTail = tail.trim();
	if (trimmedTail.length > 0) {
		paragraphs.push({ text: trimmedTail, start: lastEnd, end: text.length });
	}

	return paragraphs;
}

interface NoteChunkCache {
	textToVec: Map<string, number[]>;
}

// ── Public types ─────────────────────────────────────────────────

/**
 * Status updates the pipeline emits while running (drives the sidebar's
 * activity indicator without coupling the pipeline to the view).
 */
export interface PipelineProgress {
	embeddingParagraph(): void;
	embeddingNote(): void;
	searching(): void;
	readingPages(): void;
}

/** What the view should render. */
export type PipelineRun =
	| { kind: "noFile" }
	| { kind: "tooShort" }
	| { kind: "noIndex" }
	| { kind: "skipped" }
	| { kind: "noMatches" }
	| {
		kind: "cached";
		response: string;
		sources: ThreeLayerResult;
	}
	| {
		kind: "ready";
		messages: ChatMessage[];
		sources: ThreeLayerResult;
		cacheKey: string;
		cursorParagraph: string | null;
	};

export interface RunOptions {
	force: boolean;
	signal: AbortSignal;
	prevQueryText: string;
}

export interface RunResult {
	run: PipelineRun;
	/** The writing context this run was built from — view stores it for the next dedup check. */
	queryText: string;
}

// ── Pipeline ─────────────────────────────────────────────────────

export class ContextPipeline {
	private noteChunkCache: NoteChunkCache | null = null;
	private noteChunkCachePath = "";

	constructor(
		private app: App,
		private cache: LLMCache,
		private getSettings: () => VasoSettings,
	) {}

	/** Persist a fresh LLM response under the most recent cache key. */
	storeResponse(filePath: string, cacheKey: string, response: string): void {
		this.cache.set(filePath, cacheKey, response);
		void this.cache.save();
	}

	/** Run the full prepare phase. Returns what the view should render next. */
	async prepare(
		file: TFile,
		editor: Editor | undefined,
		opts: RunOptions,
		progress: PipelineProgress,
		vaultIndexChunks: SearchResult["chunk"][] | null,
	): Promise<RunResult> {
		const settings = this.getSettings();
		const log = getLogger();

		const rawText = editor
			? editor.getValue()
			: await this.app.vault.cachedRead(file);

		const fullText = cleanContent(rawText, settings);

		if (fullText.length < 20) {
			return { run: { kind: "tooShort" }, queryText: "" };
		}

		const writingContext = sliceWritingContext(fullText, settings.contextWords);

		if (!opts.force && writingContext === opts.prevQueryText) {
			return { run: { kind: "skipped" }, queryText: writingContext };
		}

		if (!vaultIndexChunks || vaultIndexChunks.length === 0) {
			return { run: { kind: "noIndex" }, queryText: writingContext };
		}

		// ── L0: cursor paragraph + neighbors ──
		progress.embeddingParagraph();
		const l0Ctx = this.extractL0Context(editor, rawText);
		let l0Vec: number[] | null = null;
		if (l0Ctx && settings.l0Chunks > 0) {
			log.debug("context", `── L0 query (${l0Ctx.l0QueryText.length} chars) ──`);
			log.debug("context", `  Cursor paragraph: "${truncate(l0Ctx.cursorParagraph, 120)}"`);
			log.debug("context", `  Full L0 query: "${truncate(l0Ctx.l0QueryText, 200)}"`);
			l0Vec = await embed(l0Ctx.l0QueryText, settings, opts.signal);
			if (!l0Vec || l0Vec.length === 0) {
				log.warn("context", "L0 embed returned empty vector");
			}
		} else {
			log.debug("context", `── L0 skipped (${!l0Ctx ? "no cursor" : "l0Chunks=0"}) ──`);
		}

		// ── L1: current note chunks (cached per file) ──
		progress.embeddingNote();
		const noteChunkTexts = chunkText(fullText, settings.chunkSize, settings.chunkOverlap);
		const noteChunkVecs = await this.embedNoteChunks(file.path, noteChunkTexts, settings);
		const validNoteVecs = noteChunkVecs.filter((v) => v.length > 0);
		log.debug(
			"context",
			`── Note chunks: ${noteChunkTexts.length} chunks, ${validNoteVecs.length} valid vectors ──`,
		);

		// ── Three-layer search ──
		progress.searching();
		const sources = threeLayerSearch(
			l0Vec,
			validNoteVecs,
			vaultIndexChunks as Parameters<typeof threeLayerSearch>[2],
			settings.l0Chunks,
			settings.l1Chunks,
			settings.l2Chunks,
			file.path,
		);

		if (sources.l0.length === 0 && sources.l1.length === 0 && sources.l2.length === 0) {
			return { run: { kind: "noMatches" }, queryText: writingContext };
		}

		const cacheKey = buildCacheKey(sources.l0, sources.l1, sources.l2);
		const cachedResponse = this.cache.get(file.path, cacheKey);
		if (!opts.force && cachedResponse) {
			return {
				run: { kind: "cached", response: cachedResponse, sources },
				queryText: writingContext,
			};
		}

		// ── Build prompt context ──
		progress.readingPages();
		const indexChunks = vaultIndexChunks as Parameters<typeof buildL0Context>[3];
		const l0Context = await buildL0Context(sources.l0, this.app, settings, indexChunks);
		const l1Context = await buildFullPageContext(sources.l1, this.app, settings);
		const l2Context = buildChunkContext(sources.l2);

		log.debug(
			"context",
			`L0 depth: ${settings.l0Depth}${settings.l0Depth === "nearby" ? ` (±${settings.l0NearbyRadius})` : ""}`,
		);

		const messages = buildMessages(
			settings.systemPrompt,
			writingContext,
			l0Ctx?.cursorParagraph ?? null,
			l0Context,
			l1Context,
			l2Context,
		);

		return {
			run: {
				kind: "ready",
				messages,
				sources,
				cacheKey,
				cursorParagraph: l0Ctx?.cursorParagraph ?? null,
			},
			queryText: writingContext,
		};
	}

	// ── Internals ──────────────────────────────────────────────

	/**
	 * Embed the current note's chunks, reusing cached vectors for unchanged ones.
	 * Returns vectors aligned with `texts` (an empty entry means embedding failed).
	 */
	private async embedNoteChunks(
		filePath: string,
		texts: string[],
		settings: VasoSettings,
	): Promise<number[][]> {
		const log = getLogger();

		// Same file → diff against existing cache (O(1) lookup per chunk).
		if (this.noteChunkCachePath === filePath && this.noteChunkCache) {
			const cachedMap = this.noteChunkCache.textToVec;
			const vectors: number[][] = [];
			const toEmbed: { idx: number; text: string }[] = [];

			for (let i = 0; i < texts.length; i++) {
				const cached = cachedMap.get(texts[i]!);
				if (cached && cached.length > 0) {
					vectors.push(cached);
				} else {
					vectors.push([]);
					toEmbed.push({ idx: i, text: texts[i]! });
				}
			}

			if (toEmbed.length > 0) {
				log.info(
					"context",
					`Note chunks: ${texts.length} total, ${toEmbed.length} changed — embedding`,
				);
				const newVecs = await embedBatch(toEmbed.map((e) => e.text), settings);
				for (let j = 0; j < toEmbed.length; j++) {
					const v = newVecs[j];
					if (v && v.length > 0) vectors[toEmbed[j]!.idx] = v;
				}
			} else {
				log.debug("context", `Note chunks: all ${texts.length} cached`);
			}

			this.noteChunkCache = rebuildCache(texts, vectors);
			this.noteChunkCachePath = filePath;
			return vectors;
		}

		// New file (or first run) → embed everything.
		log.info("context", `Note chunks: embedding all ${texts.length} (new file or no cache)`);
		const vectors = await embedBatch(texts, settings);
		this.noteChunkCache = rebuildCache(texts, vectors);
		this.noteChunkCachePath = filePath;
		return vectors;
	}

	/**
	 * Extract the cursor paragraph (and optionally one before / after) for the L0 query.
	 * Returns null when no editor / cursor is available.
	 */
	private extractL0Context(
		editor: Editor | undefined,
		fullText: string,
	): { l0QueryText: string; cursorParagraph: string } | null {
		if (!editor) return null;

		const cursor = editor.getCursor();
		const cursorOffset = editor.posToOffset(cursor);
		const paragraphs = splitParagraphs(fullText);
		if (paragraphs.length === 0) return null;

		let cursorIdx = paragraphs.length - 1;
		for (let i = 0; i < paragraphs.length; i++) {
			if (cursorOffset >= paragraphs[i]!.start && cursorOffset <= paragraphs[i]!.end) {
				cursorIdx = i;
				break;
			}
		}

		const cursorParagraph = paragraphs[cursorIdx]!.text;
		const includeNeighbors = this.getSettings().l0IncludeNeighborParagraphs;

		const l0Parts: string[] = [];
		if (includeNeighbors && cursorIdx > 0) l0Parts.push(paragraphs[cursorIdx - 1]!.text);
		l0Parts.push(cursorParagraph);
		if (includeNeighbors && cursorIdx < paragraphs.length - 1) {
			l0Parts.push(paragraphs[cursorIdx + 1]!.text);
		}

		return { l0QueryText: l0Parts.join("\n\n"), cursorParagraph };
	}
}

// ── Module-private helpers ────────────────────────────────────────

function sliceWritingContext(fullText: string, contextWords: number): string {
	if (contextWords <= 0) return fullText;
	const words = fullText.split(/\s+/).filter((w) => w.length > 0);
	return words.slice(Math.max(0, words.length - contextWords)).join(" ");
}

function rebuildCache(texts: string[], vectors: number[][]): NoteChunkCache {
	const map = new Map<string, number[]>();
	for (let i = 0; i < texts.length; i++) {
		const v = vectors[i];
		if (v && v.length > 0) map.set(texts[i]!, v);
	}
	return { textToVec: map };
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}
