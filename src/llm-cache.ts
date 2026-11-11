import type { DataAdapter } from "obsidian";
import { getLogger } from "./logger";

/** A single cached LLM response keyed by source chunk IDs. */
interface CacheEntry {
	cacheKey: string;
	response: string;
}

const LLM_CACHE_FILE = "vaso-llm-cache.json";
const MAX_CACHE_ENTRIES = 200;

/**
 * Persistent LLM response cache with LRU eviction.
 * Keyed by file path → { cacheKey, response }.
 */
export class LLMCache {
	private entries = new Map<string, CacheEntry>();
	private dirty = false;
	/** Bumped on every change: a write clears `dirty` only if nothing changed while it ran. */
	private changes = 0;
	/** Writes run one at a time. */
	private saving: Promise<void> = Promise.resolve();
	private pluginDir: string;
	private adapter: DataAdapter;

	constructor(adapter: DataAdapter, pluginDir: string) {
		this.adapter = adapter;
		this.pluginDir = pluginDir;
	}

	private getPath(): string {
		return this.pluginDir ? `${this.pluginDir}/${LLM_CACHE_FILE}` : LLM_CACHE_FILE;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Look up a cached response for a file. Returns the response if the cacheKey matches. */
	get(filePath: string, cacheKey: string): string | null {
		const entry = this.entries.get(filePath);
		if (entry && entry.cacheKey === cacheKey) {
			// Move to end for LRU ordering
			this.entries.delete(filePath);
			this.entries.set(filePath, entry);
			return entry.response;
		}
		return null;
	}

	/** Store a response in the cache. */
	set(filePath: string, cacheKey: string, response: string): void {
		// Delete first to refresh insertion order (LRU)
		this.entries.delete(filePath);
		this.entries.set(filePath, { cacheKey, response });
		this.dirty = true;
		this.changes++;

		// Evict oldest entries if over the limit
		while (this.entries.size > MAX_CACHE_ENTRIES) {
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
	}

	async load(): Promise<void> {
		try {
			const path = this.getPath();
			if (await this.adapter.exists(path)) {
				const raw = await this.adapter.read(path);
				const data = JSON.parse(raw) as Record<string, CacheEntry>;
				this.entries.clear();
				for (const [k, v] of Object.entries(data)) {
					if (v?.cacheKey && v?.response) {
						this.entries.set(k, v);
					}
				}
				getLogger().info("cache", `Loaded LLM cache: ${this.entries.size} entries`);
			}
		} catch (err) {
			getLogger().warn("cache", "Could not load LLM cache", err);
		}
	}

	save(): Promise<void> {
		this.saving = this.saving.then(() => this.write());
		return this.saving;
	}

	private async write(): Promise<void> {
		if (!this.dirty) return;
		const changes = this.changes;
		try {
			const obj: Record<string, CacheEntry> = {};
			for (const [k, v] of this.entries) obj[k] = v;
			await this.adapter.write(this.getPath(), JSON.stringify(obj));
			if (this.changes === changes) this.dirty = false;
		} catch (err) {
			getLogger().warn("cache", "Could not save LLM cache", err);
		}
	}
}
