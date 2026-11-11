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
	/** Paths of those files. */
	failedPaths: string[];
	/** Previously indexed files that were dropped (deleted, renamed or out of scope). */
	removedFiles: number;
	/** First embedding error, if any. */
	error?: unknown;
}

const EMBED_BATCH_SIZE = 32;

interface PendingFile {
	/**
	 * Path and mtime captured before any await: a rename or edit during the
	 * sync mutates the TFile, and the follow-up update must still see the
	 * file as changed.
	 */
	path: string;
	mtime: number;
	chunks: VaultChunk[];
	vectors: (Vector | null)[];
}

interface Plan {
	remove: Set<string>;
	toEmbed: TFile[];
}

/** Which indexed paths to drop and which files to (re-)embed, relative to `base`. */
function planSync(app: App, settings: VasoSettings, base: VaultIndex | null, paths?: Set<string>): Plan {
	const remove = new Set<string>();
	const candidates: TFile[] = [];

	if (paths) {
		for (const p of paths) {
			const f = app.vault.getAbstractFileByPath(p);
			if (f instanceof TFile && f.extension === "md" && isFileInScope(f.path, settings)) candidates.push(f);
			else remove.add(p);
		}
	} else {
		const inScope = app.vault.getMarkdownFiles().filter((f) => isFileInScope(f.path, settings));
		candidates.push(...inScope);
		const live = new Set(inScope.map((f) => f.path));
		for (const p of Object.keys(base?.mtimes ?? {})) if (!live.has(p)) remove.add(p);
	}

	return { remove, toEmbed: candidates.filter((f) => base?.mtimes[f.path] !== f.stat.mtime) };
}

/**
 * Bring the index in line with the vault.
 *
 * Unchanged files (same mtime) keep their vectors. A file is replaced only
 * when all of its chunks embedded, so a failing endpoint never drops lore that
 * was already indexed; files that failed keep their old mtime and get retried
 * on the next sync. Removals need no endpoint: when an incremental update
 * finds none, it still applies them and reports the files to embed as
 * failed. `settings` must not change while this runs (pass a snapshot).
 */
export async function syncIndex(
	app: App,
	settings: VasoSettings,
	existing: VaultIndex | null,
	opts: SyncOptions = {},
): Promise<SyncResult> {
	const log = getLogger();
	const mayRebuild = !opts.paths && (opts.full || opts.allowRebuild);
	const fail = (reason: string): never => {
		throw new IndexMismatchError(reason);
	};

	const configMismatch = existing ? indexMismatch(existing, settings) : null;
	let base = opts.full ? null : existing;
	if (base && configMismatch) {
		if (!mayRebuild) fail(configMismatch);
		base = null;
	}

	let plan = planSync(app, settings, base, opts.paths);
	let ep: EndpointConfig | null = null;
	let error: unknown;
	if (plan.toEmbed.length > 0) {
		try {
			ep = await resolveEmbeddingEndpoint(settings);
		} catch (err) {
			// Full and update runs fail as a whole; the next mtime scan covers them.
			if (!opts.paths) throw err;
			error = err;
		}
		if (ep && base && base.chunks.length > 0 && base.meta.embeddingModel !== ep.model) {
			const reason = indexMismatch(base, settings, ep.model)!;
			if (!mayRebuild) fail(reason);
			base = null;
			plan = planSync(app, settings, base, opts.paths);
		}
	}

	// A full rebuild of a still-compatible index falls back to the old vectors
	// for files that fail to embed, so an endpoint outage loses nothing.
	const fallback =
		!base && existing && !configMismatch && (!ep || existing.chunks.length === 0 || existing.meta.embeddingModel === ep.model)
			? existing
			: null;

	log.info(
		"index",
		`Sync (${opts.full ? "full" : opts.paths ? "incremental" : "update"}): ` +
			`${plan.toEmbed.length} to embed, ${plan.remove.size} to drop` +
			(ep ? `, model=${ep.model}` : ""),
	);

	// ── Chunk and embed ──
	const pending: PendingFile[] = [];
	const failedPaths: string[] = [];
	if (ep) {
		for (const file of plan.toEmbed) {
			const path = file.path;
			const mtime = file.stat.mtime;
			const chunks = await chunkFile(app, file, path, settings);
			pending.push({ path, mtime, chunks, vectors: chunks.map(() => null) });
		}
		error = await embedPending(ep, pending, opts.onProgress);
	} else {
		// No endpoint: these files keep whatever `base` holds for them.
		failedPaths.push(...plan.toEmbed.map((f) => f.path));
	}

	// ── Assemble ──
	const byFile = groupByFile(base?.chunks ?? []);
	const fallbackByFile = fallback ? groupByFile(fallback.chunks) : null;
	const mtimes: Record<string, number> = { ...(base?.mtimes ?? {}) };

	let removedFiles = 0;
	for (const p of plan.remove) {
		if (p in mtimes) removedFiles++;
		byFile.delete(p);
		delete mtimes[p];
	}

	let embeddedFiles = 0;
	let dims = base?.meta.dims ?? 0;

	for (const pf of pending) {
		if (!pf.vectors.every((v) => v !== null)) {
			failedPaths.push(pf.path);
			const oldMtime = fallback?.mtimes[pf.path];
			if (fallbackByFile && oldMtime !== undefined) {
				const old = fallbackByFile.get(pf.path) ?? [];
				if (old.length > 0) {
					byFile.set(pf.path, old);
					dims = old[0]!.vector.length;
				}
				mtimes[pf.path] = oldMtime;
			}
			continue;
		}
		const embedded = pf.chunks.map((c, i) => ({ ...c, vector: pf.vectors[i]! }));
		if (embedded.length > 0) dims = embedded[0]!.vector.length;
		byFile.set(pf.path, embedded);
		mtimes[pf.path] = pf.mtime;
		embeddedFiles++;
	}

	const chunks = [...byFile.values()].flat();
	if (chunks.some((c) => c.vector.length !== dims)) {
		fail("The embedding endpoint returned vectors of a different size.");
	}

	const index: VaultIndex = {
		chunks,
		builtAt: Date.now(),
		mtimes,
		meta: {
			embeddingModel: ep?.model ?? base?.meta.embeddingModel ?? fallback?.meta.embeddingModel ?? "",
			dims,
			configKey: indexConfigKey(settings),
		},
	};

	const failedFiles = failedPaths.length;
	log.info(
		"index",
		`Sync done: ${chunks.length} chunks, ${embeddedFiles} file(s) embedded, ${failedFiles} failed, ${removedFiles} removed`,
	);
	return { index, embeddedFiles, failedFiles, failedPaths, removedFiles, error };
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
async function chunkFile(app: App, file: TFile, path: string, settings: VasoSettings): Promise<VaultChunk[]> {
	const pageName = file.basename;
	const body = cleanContent(await app.vault.cachedRead(file), settings).trim();
	if (body.length < 20) return [];
	return chunkText(body, settings.chunkSize, settings.chunkOverlap).map((text, i) => ({
		id: `${path}#${i}`,
		filePath: path,
		pageName,
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
