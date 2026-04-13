import { Plugin, Notice, TFile } from "obsidian";
import type { VasoSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import type { VaultIndex } from "./indexer";
import { buildIndex, updateIndexForFiles, isFileInScope } from "./indexer";
import { VasoSettingTab } from "./settings";
import { CONTEXT_VIEW_TYPE, VasoContextView } from "./context-view";
import { initLogger, getLogger } from "./logger";

const INDEX_FILE = "vaso-index.json";

export default class VasoPlugin extends Plugin {
	settings: VasoSettings = DEFAULT_SETTINGS;
	vaultIndex: VaultIndex | null = null;
	indexing = false;

	/** Files that changed since the last incremental index update. */
	private pendingIndexPaths = new Set<string>();
	/** Timer handle for the index debounce. */
	private indexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timer handle for debounced index-to-disk writes (the index file is large; coalesce edits). */
	private saveIndexDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		initLogger(this.app.vault.adapter, this.manifest.dir ?? "", {
			enabled: this.settings.debugLogging,
			maxFileSizeBytes: this.settings.debugLogMaxSizeMB * 1024 * 1024,
			flushIntervalMs: 5000,
		});

		this.addSettingTab(new VasoSettingTab(this.app, this));

		this.registerView(CONTEXT_VIEW_TYPE, (leaf) => {
			return new VasoContextView(leaf, this);
		});

		this.addCommand({
			id: "open-context-panel",
			name: "Open lore context panel",
			callback: () => {
				this.activateView();
			},
		});

		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild vault index",
			callback: () => {
				this.rebuildIndex();
			},
		});

		await this.loadIndex();

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.contextPanelEnabled) {
				this.activateView();
			}

			// Auto-rebuild on first load when no cached index is present.
			if (!this.vaultIndex || this.vaultIndex.chunks.length === 0) {
				this.rebuildIndex(true);
			}
		});

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") {
					this.scheduleIndexUpdate(file.path);
					if (oldPath) this.scheduleIndexUpdate(oldPath);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.scheduleIndexUpdate(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.scheduleIndexUpdate(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					this.scheduleIndexUpdate(file.path);
				}
			})
		);
	}

	async onunload(): Promise<void> {
		if (this.indexDebounceTimer) {
			clearTimeout(this.indexDebounceTimer);
			this.indexDebounceTimer = null;
		}
		if (this.saveIndexDebounceTimer) {
			clearTimeout(this.saveIndexDebounceTimer);
			this.saveIndexDebounceTimer = null;
		}
		// Flush any pending incremental updates before we shut down.
		if (this.pendingIndexPaths.size > 0 && this.vaultIndex) {
			try {
				this.vaultIndex = await updateIndexForFiles(
					this.app, this.settings, this.vaultIndex,
					this.pendingIndexPaths
				);
				this.pendingIndexPaths.clear();
			} catch { /* best-effort */ }
		}
		await this.writeIndexNow();

		await getLogger().destroy();
	}

	// ── Debounced incremental indexing ───────────────────────

	/**
	 * Schedule an incremental index update for a changed file.
	 * Collects paths and fires after the configured debounce period.
	 * Disabled when indexDebounceMs is 0.
	 */
	private scheduleIndexUpdate(filePath: string): void {
		if (this.settings.indexDebounceMs <= 0) return;
		if (!this.vaultIndex) return; // no index yet — nothing to update

		this.pendingIndexPaths.add(filePath);

		if (this.indexDebounceTimer) {
			clearTimeout(this.indexDebounceTimer);
		}

		this.indexDebounceTimer = setTimeout(() => {
			this.indexDebounceTimer = null;
			this.flushIndexUpdate();
		}, this.settings.indexDebounceMs);
	}

	/** Run the pending incremental index update. */
	private async flushIndexUpdate(): Promise<void> {
		if (this.pendingIndexPaths.size === 0) return;
		if (!this.vaultIndex) return;
		if (this.indexing) {
			// A full rebuild is running — reschedule
			this.indexDebounceTimer = setTimeout(() => {
				this.indexDebounceTimer = null;
				this.flushIndexUpdate();
			}, 2000);
			return;
		}

		const paths = new Set(this.pendingIndexPaths);
		this.pendingIndexPaths.clear();

		getLogger().info("main", `Auto-updating index for ${paths.size} file(s)`);
		this.refreshContextViewStatusBar();
		try {
			this.vaultIndex = await updateIndexForFiles(
				this.app, this.settings, this.vaultIndex, paths
			);
			this.scheduleSaveIndex();
			getLogger().info("main", `Auto-update complete — ${this.vaultIndex.chunks.length} chunks`);
		} catch (err) {
			getLogger().error("main", "Auto-update failed", err);
		}
		this.refreshContextViewStatusBar();
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ── Index persistence ─────────────────────────────────────

	private getIndexPath(): string {
		const dir = this.manifest.dir;
		return dir ? `${dir}/${INDEX_FILE}` : INDEX_FILE;
	}

	private async loadIndex(): Promise<void> {
		try {
			const path = this.getIndexPath();
			const adapter = this.app.vault.adapter;
			if (await adapter.exists(path)) {
				const raw = await adapter.read(path);
				this.vaultIndex = JSON.parse(raw) as VaultIndex;
				getLogger().info("main", `Loaded index: ${this.vaultIndex.chunks.length} chunks`);
			}
		} catch (err) {
			getLogger().warn("main", "Could not load cached index", err);
			this.vaultIndex = null;
		}
	}

	/** Coalesce index writes — the file can be megabytes, so don't rewrite it on every keystroke. */
	private static SAVE_INDEX_DEBOUNCE_MS = 5000;

	private scheduleSaveIndex(): void {
		if (this.saveIndexDebounceTimer) clearTimeout(this.saveIndexDebounceTimer);
		this.saveIndexDebounceTimer = setTimeout(() => {
			this.saveIndexDebounceTimer = null;
			this.writeIndexNow();
		}, VasoPlugin.SAVE_INDEX_DEBOUNCE_MS);
	}

	private async writeIndexNow(): Promise<void> {
		if (this.saveIndexDebounceTimer) {
			clearTimeout(this.saveIndexDebounceTimer);
			this.saveIndexDebounceTimer = null;
		}
		if (!this.vaultIndex) return;
		try {
			const path = this.getIndexPath();
			await this.app.vault.adapter.write(
				path,
				JSON.stringify(this.vaultIndex)
			);
		} catch (err) {
			getLogger().warn("main", "Could not save index", err);
		}
	}

	// ── Commands ──────────────────────────────────────────────

	/**
	 * Rebuild the vault index.
	 * @param full  If true, discard the existing index and re-embed everything.
	 *              If false, incrementally update (only changed files).
	 */
	async rebuildIndex(full = true): Promise<void> {
		if (this.indexing) {
			new Notice("Vaso: Already indexing…");
			return;
		}

		this.indexing = true;
		this.refreshContextViewStatusBar();
		new Notice(
			full
				? "Vaso: Full index rebuild…"
				: "Vaso: Updating vault index…"
		);

		try {
			this.vaultIndex = await buildIndex(
				this.app,
				this.settings,
				full ? null : this.vaultIndex,
				(done, total) => {
					if (done % 50 === 0 || done === total) {
						new Notice(
							`Vaso: Indexed ${done}/${total} chunks…`,
							2000
						);
					}
				}
			);

			await this.writeIndexNow();
			new Notice(
				`Vaso: Index built — ${this.vaultIndex.chunks.length} chunks`
			);
		} catch (err) {
			getLogger().error("main", "Index build failed", err);
			new Notice(`Vaso: Index build failed — ${String(err)}`);
		} finally {
			this.indexing = false;
			this.refreshContextViewStatusBar();
		}
	}

	/** Tell the context view to re-render its status bar. */
	refreshContextViewStatusBar(): void {
		const leaves = this.app.workspace.getLeavesOfType(CONTEXT_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof VasoContextView) {
				view.renderStatusBar();
			}
		}
	}

	async activateView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(CONTEXT_VIEW_TYPE);
		if (existing.length > 0) return;

		const rightLeaf = this.app.workspace.getRightLeaf(false);
		if (rightLeaf) {
			await rightLeaf.setViewState({
				type: CONTEXT_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(rightLeaf);
		}
	}
}

