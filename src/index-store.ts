import { Notice } from "obsidian";
import type { App } from "obsidian";
import type { VasoSettings, VaultChunk } from "./types";
import type { IndexMeta, SyncOptions, VaultIndex } from "./indexer";
import { IndexMismatchError, hasIndexScope, indexConfigKey, syncIndex } from "./indexer";
import { decodeVector, encodeVector, toUnitVector } from "./vectors";
import { errorMessage } from "./errors";
import { getLogger } from "./logger";

const INDEX_FILE = "vaso-index.json";
const STORE_VERSION = 2;
/** The index file can be megabytes; coalesce writes. */
const SAVE_DEBOUNCE_MS = 5000;

interface StoredIndex {
	version: typeof STORE_VERSION;
	builtAt: number;
	mtimes: Record<string, number>;
	meta: IndexMeta;
	chunks: (VaultChunk & { vector: string })[];
}

/** Format written before v2: raw number[] vectors and no metadata. */
interface LegacyIndex {
	builtAt?: number;
	mtimes?: Record<string, number>;
	chunks?: (VaultChunk & { vector: number[] })[];
}

export interface IndexProgress {
	label: string;
	done: number;
	total: number;
}

/**
 * Owns the vault index: loading, saving, and every update. Updates run one at
 * a time through a queue, so a full rebuild and an incremental update never
 * race to overwrite each other.
 */
export class IndexStore {
	index: VaultIndex | null = null;
	/** Set while an update runs. */
	progress: IndexProgress | null = null;
	/** Why the index can't be used or updated right now (shown in the panel). */
	problem: string | null = null;
	/** The problem is an incompatible index: only a rebuild fixes it. */
	needsRebuild = false;

	private queue: Promise<void> = Promise.resolve();
	private pendingPaths = new Set<string>();
	private updateTimer: number | null = null;
	private saveTimer: number | null = null;
	private dirty = false;

	constructor(
		private app: App,
		private pluginDir: string,
		private getSettings: () => VasoSettings,
		private onChange: () => void,
	) {}

	private get filePath(): string {
		return this.pluginDir ? `${this.pluginDir}/${INDEX_FILE}` : INDEX_FILE;
	}

	get chunkCount(): number {
		return this.index?.chunks.length ?? 0;
	}

	get pageCount(): number {
		return this.index ? new Set(this.index.chunks.map((c) => c.filePath)).size : 0;
	}

	// ── Persistence ──────────────────────────────────────────

	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.filePath))) return;
			const raw = JSON.parse(await adapter.read(this.filePath)) as StoredIndex | LegacyIndex;
			if ("version" in raw && raw.version === STORE_VERSION) {
				this.index = fromStored(raw);
			} else {
				this.index = fromLegacy(raw as LegacyIndex, this.getSettings());
				this.dirty = true; // rewrite in the current format on the next save
			}
			getLogger().info("main", `Loaded index: ${this.index.chunks.length} chunks`);
		} catch (err) {
			getLogger().warn("main", "Could not load the saved index", err);
			this.index = null;
		}
	}

	private scheduleSave(): void {
		this.dirty = true;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, SAVE_DEBOUNCE_MS);
	}

	async save(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty || !this.index) return;
		try {
			await this.app.vault.adapter.write(this.filePath, JSON.stringify(toStored(this.index)));
			this.dirty = false;
		} catch (err) {
			getLogger().warn("main", "Could not save the index", err);
		}
	}

	async shutdown(): Promise<void> {
		if (this.updateTimer !== null) window.clearTimeout(this.updateTimer);
		this.updateTimer = null;
		// Pending paths are picked up by the mtime check on the next start.
		await this.save();
	}

	/** The panel found the index unusable with the current embedding endpoint. */
	reportMismatch(message: string): void {
		if (this.problem === message && this.needsRebuild) return;
		this.problem = message;
		this.needsRebuild = true;
		this.onChange();
	}

	// ── Updates ──────────────────────────────────────────────

	/** A file changed: queue an incremental update after the debounce. */
	noteChanged(path: string): void {
		const delay = this.getSettings().indexDebounceMs;
		if (delay <= 0 || !this.index) return;
		this.pendingPaths.add(path);
		if (this.updateTimer !== null) window.clearTimeout(this.updateTimer);
		this.updateTimer = window.setTimeout(() => {
			this.updateTimer = null;
			const paths = new Set(this.pendingPaths);
			this.pendingPaths.clear();
			void this.run("Updating index", { paths }, false);
		}, delay);
	}

	/**
	 * Re-embed whatever changed since the last sync (mtime check across the
	 * vault). `manual` shows notices and may rebuild an index that no longer
	 * matches the settings; the startup sync only reports that.
	 */
	update(manual: boolean): Promise<void> {
		return this.run("Updating index", { allowRebuild: manual }, manual);
	}

	/** Discard the index and embed every in-scope file again. */
	rebuild(): Promise<void> {
		return this.run("Rebuilding index", { full: true }, true);
	}

	private run(label: string, opts: SyncOptions, notify: boolean): Promise<void> {
		const task = () => this.sync(label, opts, notify);
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async sync(label: string, opts: SyncOptions, notify: boolean): Promise<void> {
		const settings = this.getSettings();
		if (!hasIndexScope(settings)) {
			this.problem = "No folders are selected for indexing yet. Choose them in Settings → Vaso → Index.";
			this.onChange();
			if (notify) new Notice(`Vaso: ${this.problem}`);
			return;
		}

		const notice = notify ? new Notice(`Vaso: ${label}…`, 0) : null;
		this.progress = { label, done: 0, total: 0 };
		this.onChange();

		try {
			const result = await syncIndex(this.app, settings, this.index, {
				...opts,
				onProgress: (done, total) => {
					this.progress = { label, done, total };
					notice?.setMessage(`Vaso: ${label} — ${done}/${total} chunks`);
					this.onChange();
				},
			});
			this.index = result.index;
			if (result.embeddedFiles > 0 || result.removedFiles > 0 || opts.full) {
				this.scheduleSave();
				if (notify) await this.save();
			}

			this.needsRebuild = false;
			if (result.error) {
				this.problem =
					`${result.failedFiles} file(s) could not be embedded (${errorMessage(result.error)}). ` +
					"They keep their previous version and are retried on the next update.";
			} else {
				this.problem = null;
			}
			notice?.setMessage(
				result.error
					? `Vaso: ${this.problem}`
					: `Vaso: index ready — ${this.chunkCount} chunks from ${this.pageCount} pages`,
			);
		} catch (err) {
			this.needsRebuild = err instanceof IndexMismatchError;
			this.problem = this.needsRebuild
				? `${errorMessage(err)} Rebuild the index to use it again.`
				: `Index update failed: ${errorMessage(err)}`;
			getLogger().error("index", label + " failed", err);
			notice?.setMessage(`Vaso: ${this.problem}`);
		} finally {
			this.progress = null;
			this.onChange();
			if (notice) window.setTimeout(() => notice.hide(), 5000);
		}
	}
}

// ── Serialisation ─────────────────────────────────────────────

function toStored(index: VaultIndex): StoredIndex {
	return {
		version: STORE_VERSION,
		builtAt: index.builtAt,
		mtimes: index.mtimes,
		meta: index.meta,
		chunks: index.chunks.map((c) => ({ ...c, vector: encodeVector(c.vector) })),
	};
}

function fromStored(s: StoredIndex): VaultIndex {
	return {
		builtAt: s.builtAt,
		mtimes: s.mtimes,
		meta: s.meta,
		chunks: s.chunks.map((c) => ({ ...c, vector: decodeVector(c.vector) })),
	};
}

/** Adopt a pre-v2 index, assuming it was built with the current settings and first embedding model. */
function fromLegacy(raw: LegacyIndex, settings: VasoSettings): VaultIndex {
	const chunks = (raw.chunks ?? [])
		.filter((c) => Array.isArray(c.vector) && c.vector.length > 0)
		.map((c) => ({ ...c, vector: toUnitVector(c.vector) }));
	getLogger().info("main", "Converting index from the old format");
	return {
		chunks,
		builtAt: raw.builtAt ?? Date.now(),
		mtimes: raw.mtimes ?? {},
		meta: {
			embeddingModel: settings.embeddingEndpoints[0]?.model ?? "",
			dims: chunks[0]?.vector.length ?? 0,
			configKey: indexConfigKey(settings),
		},
	};
}
