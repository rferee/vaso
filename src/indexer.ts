import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { EndpointConfig, VasoSettings, VaultChunk, EmbeddedChunk } from "./types";
import { resolveEmbeddingEndpoint, embedTexts } from "./llm";
import { chunkText, cleanContent, hashString } from "./text";
import type { Vector } from "./vectors";
import { getLogger } from "./logger";

// ── Index model ──────────────────────────────────────────────────

/** What the stored vectors depend on. A mismatch means they can't be reused. */
export interface IndexMeta {
	/** Model name of the embedding endpoint that produced the vectors. */
	embeddingModel: string;
	/** Vector length (0 while the index is empty). */
	dims: number;
	/** Hash of the chunking and cleaning settings. */
	configKey: string;
}

export interface VaultIndex {
	chunks: EmbeddedChunk[];
	/** Timestamp of the last build or update. */
	builtAt: number;
	/** filePath → mtime of the version that is indexed. */
	mtimes: Record<string, number>;
	meta: IndexMeta;
}

export function indexConfigKey(settings: VasoSettings): string {
	return hashString(
		JSON.stringify([
			settings.chunkSize,
			settings.chunkOverlap,
			settings.stripFrontmatter,
			settings.stripCallouts,
			settings.stripCallouts
				? settings.calloutWhitelist.map((w) => w.toLowerCase()).sort()
				: [],
		]),
	);
}

/** Why `index` can't be used with the current settings, or null when it can. */
export function indexMismatch(
	index: VaultIndex,
	settings: VasoSettings,
	embeddingModel?: string,
): string | null {
	if (index.meta.configKey !== indexConfigKey(settings)) {
		return "Chunking or cleaning settings changed since the index was built.";
	}
	if (embeddingModel !== undefined && index.meta.embeddingModel !== embeddingModel) {
		return `The index was built with "${index.meta.embeddingModel}", but the embedding endpoint now uses "${embeddingModel}".`;
	}
	return null;
}

// ── Scope ────────────────────────────────────────────────────────

/** Root files need `indexRoot`; everything else must sit under an indexed directory. */
export function isFileInScope(filePath: string, settings: VasoSettings): boolean {
	if (!filePath.includes("/")) return settings.indexRoot;
	return settings.indexedDirectories.some((dir) => {
		const d = dir.replace(/^\/+|\/+$/g, "");
		return d.length > 0 && filePath.startsWith(d + "/");
	});
}

export function hasIndexScope(settings: VasoSettings): boolean {
	return settings.indexRoot || settings.indexedDirectories.some((d) => d.trim().length > 0);
}

// ── Sync ─────────────────────────────────────────────────────────

/** Thrown when an incremental update would mix incompatible vectors. */
export class IndexMismatchError extends Error {}

export interface SyncOptions {
	/** Re-embed every in-scope file, ignoring the existing index. */
	full?: boolean;
	/**
	 * When the existing index doesn't match the settings or model, rebuild it
	 * from scratch instead of throwing IndexMismatchError. Never applies to
	 * incremental updates.
	 */
	allowRebuild?: boolean;
	/** Only look at these paths (incremental update). Default: the whole vault. */
	paths?: Set<string>;
	onProgress?: (done: number, total: number) => void;
}

export interface SyncResult {
	index: VaultIndex;
	/** Files whose chunks were (re-)embedded. */
	embeddedFiles: number;
	/** Files that needed embedding but kept their old chunks (or none) because embedding failed. */
	failedFiles: number;
	/** Previously indexed files that were dropped (deleted, renamed or out of scope). */
	removedFiles: number;
	/** First embedding error, if any. */
	error?: unknown;
}

const EMBED_BATCH_SIZE = 32;

interface PendingFile {
	file: TFile;
	chunks: VaultChunk[];
	vectors: (Vector | null)[];
}

/**
 * Bring the index in line with the vault.
 *
 * Unchanged files (same mtime) keep their vectors. A file is replaced only
 * when all of its chunks embedded, so a failing endpoint never drops lore that
 * was already indexed; files that failed keep their old mtime and get retried
 * on the next sync.
 */
export async function syncIndex(
	app: App,
	settings: VasoSettings,
	existing: VaultIndex | null,
	opts: SyncOptions = {},
): Promise<SyncResult> {
	const log = getLogger();
	const ep = await resolveEmbeddingEndpoint(settings);

	let base = existing;
	const mismatch = base ? indexMismatch(base, settings, ep.model) : null;
	if (base && mismatch && !opts.full && (opts.paths || !opts.allowRebuild)) {
		throw new IndexMismatchError(mismatch);
	}
	// A full rebuild of a still-compatible index falls back to the old vectors
	// for files that fail to embed, so an endpoint outage loses nothing.
	const fallback = existing && !mismatch ? existing : null;
	if (opts.full || mismatch) base = null;

	// ── Decide what to drop, keep and embed ──
	const remove = new Set<string>();
	const candidates: TFile[] = [];

	if (opts.paths) {
		for (const p of opts.paths) {
			const f = app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile && f.extension === "md" && isFileInScope(f.path, settings)) {
				candidates.push(f);
			} else {
				remove.add(p);
			}
		}
	} else {
		const inScope = app.vault
			.getMarkdownFiles()
			.filter((f) => isFileInScope(f.path, settings));
		candidates.push(...inScope);
		const live = new Set(inScope.map((f) => f.path));
		for (const p of Object.keys(base?.mtimes ?? {})) {
			if (!live.has(p)) remove.add(p);
		}
	}

	const toEmbed = candidates.filter((f) => base?.mtimes[f.path] !== f.stat.mtime);

	log.info(
		"index",
		`Sync (${opts.full ? "full" : opts.paths ? "incremental" : "update"}): ` +
			`${candidates.length} candidate(s), ${toEmbed.length} to embed, ${remove.size} to drop, model=${ep.model}`,
	);

	// ── Chunk ──
	const pending: PendingFile[] = [];
	for (const file of toEmbed) {
		const chunks = await chunkFile(app, file, settings);
		pending.push({ file, chunks, vectors: chunks.map(() => null) });
	}

	// ── Embed ──
	const error = await embedPending(ep, pending, opts.onProgress);

	// ── Assemble ──
	const byFile = groupByFile(base?.chunks ?? []);
	const fallbackByFile = !base && fallback ? groupByFile(fallback.chunks) : null;
	const mtimes: Record<string, number> = { ...(base?.mtimes ?? {}) };

	let removedFiles = 0;
	for (const p of remove) {
		if (p in mtimes) removedFiles++;
		byFile.delete(p);
		delete mtimes[p];
	}

	let embeddedFiles = 0;
	let failedFiles = 0;
	let dims = base?.meta.dims ?? 0;

	for (const pf of pending) {
		if (!pf.vectors.every((v) => v !== null)) {
			failedFiles++;
			const oldMtime = fallback?.mtimes[pf.file.path];
			if (fallbackByFile && oldMtime !== undefined) {
				const old = fallbackByFile.get(pf.file.path) ?? [];
				if (old.length > 0) {
					byFile.set(pf.file.path, old);
					dims = old[0]!.vector.length;
				}
				mtimes[pf.file.path] = oldMtime;
			}
			continue;
		}
		const embedded = pf.chunks.map((c, i) => ({ ...c, vector: pf.vectors[i]! }));
		if (embedded.length > 0) dims = embedded[0]!.vector.length;
		byFile.set(pf.file.path, embedded);
		mtimes[pf.file.path] = pf.file.stat.mtime;
		embeddedFiles++;
	}

	const chunks = [...byFile.values()].flat();
	if (chunks.some((c) => c.vector.length !== dims)) {
		throw new IndexMismatchError("The embedding endpoint returned vectors of a different size.");
	}

	const index: VaultIndex = {
		chunks,
		builtAt: Date.now(),
		mtimes,
		meta: { embeddingModel: ep.model, dims, configKey: indexConfigKey(settings) },
	};

	log.info(
		"index",
		`Sync done: ${chunks.length} chunks, ${embeddedFiles} file(s) embedded, ${failedFiles} failed`,
	);
	return { index, embeddedFiles, failedFiles, removedFiles, error };
}

function groupByFile(chunks: EmbeddedChunk[]): Map<string, EmbeddedChunk[]> {
	const byFile = new Map<string, EmbeddedChunk[]>();
	for (const c of chunks) {
		const arr = byFile.get(c.filePath);
		if (arr) arr.push(c);
		else byFile.set(c.filePath, [c]);
	}
	return byFile;
}

/** Read, clean and chunk one file. Files with almost no text yield no chunks. */
async function chunkFile(app: App, file: TFile, settings: VasoSettings): Promise<VaultChunk[]> {
	const body = cleanContent(await app.vault.cachedRead(file), settings).trim();
	if (body.length < 20) return [];
	return chunkText(body, settings.chunkSize, settings.chunkOverlap).map((text, i) => ({
		id: `${file.path}#${i}`,
		filePath: file.path,
		pageName: file.basename,
		text,
		chunkIndex: i,
	}));
}

/** Embed all pending chunks in batches with one endpoint. Stops at the first failed batch. */
async function embedPending(
	ep: EndpointConfig,
	pending: PendingFile[],
	onProgress?: (done: number, total: number) => void,
): Promise<unknown> {
	const slots: { pf: PendingFile; i: number }[] = [];
	for (const pf of pending) pf.chunks.forEach((_, i) => slots.push({ pf, i }));

	for (let start = 0; start < slots.length; start += EMBED_BATCH_SIZE) {
		const batch = slots.slice(start, start + EMBED_BATCH_SIZE);
		try {
			const vecs = await embedTexts(ep, batch.map((s) => s.pf.chunks[s.i]!.text));
			batch.forEach((s, j) => (s.pf.vectors[s.i] = vecs[j] ?? null));
		} catch (err) {
			getLogger().error("index", "Embedding batch failed", err);
			return err;
		}
		onProgress?.(Math.min(start + batch.length, slots.length), slots.length);
	}
	return undefined;
}
