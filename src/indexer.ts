import { App, TFile, Notice } from "obsidian";
import type {
	VasoSettings,
	VaultChunk,
	EmbeddedChunk,
} from "./types";
import { embedBatch } from "./llm";
import { getLogger } from "./logger";

// ── Scope filtering ──────────────────────────────────────────────

/**
 * Check whether a file path falls within the configured index scope.
 * - If the file is in the vault root (no `/`), it's included only if `indexRoot` is true.
 * - Otherwise, it must be under one of the `indexedDirectories`.
 */
export function isFileInScope(
	filePath: string,
	settings: VasoSettings
): boolean {
	const slashIndex = filePath.indexOf("/");

	// File is in vault root (no directory)
	if (slashIndex === -1) {
		return settings.indexRoot;
	}

	// Check against whitelisted directories
	for (const dir of settings.indexedDirectories) {
		if (dir.length === 0) continue;
		// Normalise: match "Geography & Regions" against "Geography & Regions/..."
		const prefix = dir.endsWith("/") ? dir : dir + "/";
		if (filePath.startsWith(prefix)) return true;
	}

	return false;
}

// ── Frontmatter stripping ────────────────────────────────────────

export const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

export function stripFrontmatter(text: string): string {
	return text.replace(FRONTMATTER_RE, "").trim();
}

// ── Chunking ─────────────────────────────────────────────────────

export function chunkText(
	text: string,
	chunkSize: number,
	overlap: number
): string[] {
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	if (words.length === 0) return [];

	const chunks: string[] = [];
	let start = 0;
	while (start < words.length) {
		const end = Math.min(start + chunkSize, words.length);
		chunks.push(words.slice(start, end).join(" "));
		if (end >= words.length) break;
		start += chunkSize - overlap;
	}
	return chunks;
}

/**
 * Read a file, strip frontmatter, chunk the body, and emit VaultChunks.
 * Returns an empty array for files smaller than the chunk threshold (after stripping).
 */
async function chunkFileToVaultChunks(
	app: App,
	file: TFile,
	settings: VasoSettings,
): Promise<VaultChunk[]> {
	const raw = await app.vault.cachedRead(file);
	const body = stripFrontmatter(raw);
	if (body.length < 20) return [];

	const textChunks = chunkText(body, settings.chunkSize, settings.chunkOverlap);
	const out: VaultChunk[] = [];
	for (let i = 0; i < textChunks.length; i++) {
		const tc = textChunks[i];
		if (!tc) continue;
		out.push({
			id: `${file.path}#${i}`,
			filePath: file.path,
			pageName: file.basename,
			text: tc,
			chunkIndex: i,
		});
	}
	return out;
}

// ── Batch embedding helper ───────────────────────────────────────

const EMBED_BATCH_SIZE = 32;

/**
 * Embed an array of VaultChunks in batches, returning the successfully embedded chunks.
 * On batch failure, returns whatever was embedded so far (partial result).
 */
async function embedChunks(
	chunks: VaultChunk[],
	settings: VasoSettings,
	onProgress?: (done: number, total: number) => void
): Promise<{ embedded: EmbeddedChunk[]; error?: unknown }> {
	const embedded: EmbeddedChunk[] = [];
	let done = 0;

	for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
		const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
		try {
			getLogger().debug("index", `Embedding batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1} (${batch.length} chunks)`);
			const vectors = await embedBatch(
				batch.map((c) => c.text),
				settings
			);
			for (let j = 0; j < batch.length; j++) {
				const chunk = batch[j];
				const vec = vectors[j];
				if (chunk && vec && vec.length > 0) {
					embedded.push({ ...chunk, vector: vec });
				} else if (chunk) {
					getLogger().warn("index", `Skipped chunk with empty vector: ${chunk.id}`);
				}
			}
		} catch (err) {
			getLogger().error("index", "Embedding batch failed", err);
			return { embedded, error: err };
		}
		done += batch.length;
		onProgress?.(done, chunks.length);
	}

	return { embedded };
}

// ── Full vault indexing ──────────────────────────────────────────

export interface VaultIndex {
	chunks: EmbeddedChunk[];
	/** Timestamp of last full rebuild */
	builtAt: number;
	/** Map of filePath → mtime at index time */
	mtimes: Record<string, number>;
}

/**
 * Build or incrementally update the vault embedding index.
 * Returns the updated index.
 */
export async function buildIndex(
	app: App,
	settings: VasoSettings,
	existing: VaultIndex | null,
	onProgress?: (done: number, total: number) => void
): Promise<VaultIndex> {
	const allFiles = app.vault.getMarkdownFiles();
	const files = allFiles.filter((f) => isFileInScope(f.path, settings));

	const log = getLogger();
	log.info("index", "Index build started");
	log.info("index", `Total markdown files in vault: ${allFiles.length}`);
	log.info("index", `Files in scope: ${files.length}`);
	log.info("index", `Indexed directories: ${JSON.stringify(settings.indexedDirectories)}`);
	log.info("index", `Index root: ${settings.indexRoot}`);
	log.debug("index", `Embedding endpoints: ${JSON.stringify(settings.embeddingEndpoints.map(e => ({ name: e.name, url: e.url, model: e.model })))}`);

	if (files.length === 0) {
		log.warn("index", "WARNING: No files matched the index scope! Check your indexed directories.");
		// Log a sample of actual file paths to help debug
		const samplePaths = allFiles.slice(0, 10).map((f) => f.path);
		log.debug("index", `Sample vault paths: ${JSON.stringify(samplePaths)}`);
	}

	const mtimes: Record<string, number> = {};
	const existingMtimes = existing?.mtimes ?? {};
	const existingChunkMap = new Map<string, EmbeddedChunk[]>();

	// Build a lookup from existing index
	if (existing) {
		for (const chunk of existing.chunks) {
			const arr = existingChunkMap.get(chunk.filePath) ?? [];
			arr.push(chunk);
			existingChunkMap.set(chunk.filePath, arr);
		}
	}

	// Determine which files need re-embedding
	const toProcess: TFile[] = [];
	const unchanged: EmbeddedChunk[] = [];

	for (const file of files) {
		const mtime = file.stat.mtime;
		mtimes[file.path] = mtime;

		if (existingMtimes[file.path] === mtime && existingChunkMap.has(file.path)) {
			// File unchanged — keep existing chunks
			const cached = existingChunkMap.get(file.path);
			if (cached) unchanged.push(...cached);
		} else {
			toProcess.push(file);
		}
	}

	log.info("index", `Unchanged files (cached): ${files.length - toProcess.length}`);
	log.info("index", `Files to (re-)embed: ${toProcess.length}`);

	if (toProcess.length === 0 && existing) {
		// Nothing changed — remove chunks for deleted files
		const currentPaths = new Set(files.map((f) => f.path));
		const filtered = existing.chunks.filter((c) =>
			currentPaths.has(c.filePath)
		);
		return { chunks: filtered, builtAt: Date.now(), mtimes };
	}

	const newChunks: VaultChunk[] = [];
	for (const file of toProcess) {
		newChunks.push(...(await chunkFileToVaultChunks(app, file, settings)));
	}

	log.info("index", `Total new chunks to embed: ${newChunks.length}`);

	const { embedded: embeddedNew, error } = await embedChunks(newChunks, settings, onProgress);

	if (error) {
		new Notice(`Vaso: embedding failed — ${String(error)}`);
		return { chunks: [...unchanged, ...embeddedNew], builtAt: Date.now(), mtimes };
	}

	const finalCount = unchanged.length + embeddedNew.length;
	log.info("index", `Index build complete: ${finalCount} total chunks (${unchanged.length} cached + ${embeddedNew.length} new)`);

	return {
		chunks: [...unchanged, ...embeddedNew],
		builtAt: Date.now(),
		mtimes,
	};
}

// ── Incremental file update ──────────────────────────────────────

/**
 * Update the index for a specific set of changed/deleted file paths.
 * Much faster than a full rebuild — only re-embeds the affected files.
 * Returns the updated index, or null if there's nothing to do.
 */
export async function updateIndexForFiles(
	app: App,
	settings: VasoSettings,
	existing: VaultIndex,
	changedPaths: Set<string>
): Promise<VaultIndex> {
	getLogger().info("index", `Incremental update for ${changedPaths.size} file(s): ${[...changedPaths].join(", ")}`);

	// Filter to only in-scope paths
	const scopedPaths = [...changedPaths].filter((p) => isFileInScope(p, settings));
	// Also include out-of-scope paths that were previously indexed (file moved out / deleted)
	const previouslyIndexed = [...changedPaths].filter(
		(p) => !isFileInScope(p, settings) && existing.mtimes[p] !== undefined
	);
	const allAffected = new Set([...scopedPaths, ...previouslyIndexed]);

	if (allAffected.size === 0) {
		getLogger().info("index", "No affected files in scope, skipping.");
		return existing;
	}

	// Remove old chunks for affected files
	const kept = existing.chunks.filter((c) => !allAffected.has(c.filePath));
	const newMtimes = { ...existing.mtimes };

	// Remove mtimes for affected files (will re-add for files that still exist)
	for (const p of allAffected) {
		delete newMtimes[p];
	}

	const newChunks: VaultChunk[] = [];
	for (const filePath of scopedPaths) {
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile) || file.extension !== "md") continue;

		const fileChunks = await chunkFileToVaultChunks(app, file, settings);
		if (fileChunks.length === 0) continue;

		newMtimes[filePath] = file.stat.mtime;
		newChunks.push(...fileChunks);
	}

	if (newChunks.length === 0) {
		// All affected files were deleted or out of scope — just return with removals
		getLogger().info("index", `Incremental update: removed chunks for ${allAffected.size} file(s), ${kept.length} chunks remain.`);
		return { chunks: kept, builtAt: existing.builtAt, mtimes: newMtimes };
	}

	getLogger().info("index", `Incremental update: embedding ${newChunks.length} chunks`);
	const { embedded: embeddedNew, error } = await embedChunks(newChunks, settings);

	if (error) {
		// Mirror buildIndex: keep whatever embedded successfully before the failure
		return {
			chunks: [...kept, ...embeddedNew],
			builtAt: existing.builtAt,
			mtimes: newMtimes,
		};
	}

	const total = kept.length + embeddedNew.length;
	getLogger().info("index", `Incremental update complete: ${total} total chunks (${kept.length} kept + ${embeddedNew.length} new)`);

	return {
		chunks: [...kept, ...embeddedNew],
		builtAt: existing.builtAt,
		mtimes: newMtimes,
	};
}
