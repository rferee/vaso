import { Platform, Plugin, TFile } from "obsidian";
import type { TAbstractFile } from "obsidian";
import type { VasoSettings } from "./types";
import { normalizeSettings } from "./types";
import { VasoSettingTab } from "./settings";
import { CONTEXT_VIEW_TYPE, VasoContextView } from "./context-view";
import { IndexStore } from "./index-store";
import { clearResolveCache } from "./llm";
import { initLogger, getLogger, destroyLogger } from "./logger";

export default class VasoPlugin extends Plugin {
	settings!: VasoSettings;
	store!: IndexStore;

	async onload(): Promise<void> {
		await this.loadSettings();

		initLogger(this.app.vault.adapter, this.manifest.dir ?? "", {
			enabled: this.settings.debugLogging,
			maxFileSizeBytes: this.settings.debugLogMaxSizeMB * 1024 * 1024,
			flushIntervalMs: 5000,
		});

		this.store = new IndexStore(
			this.app,
			this.manifest.dir ?? "",
			() => this.settings,
			() => this.refreshViews(),
		);

		this.addSettingTab(new VasoSettingTab(this.app, this));
		this.registerView(CONTEXT_VIEW_TYPE, (leaf) => new VasoContextView(leaf, this));
		this.addRibbonIcon("book-open", "Open Vaso lore panel", () => void this.activateView(true));

		this.addCommand({
			id: "open-context-panel",
			name: "Open lore context panel",
			callback: () => void this.activateView(true),
		});
		this.addCommand({
			id: "refresh-context",
			name: "Refresh lore context",
			callback: () => {
				for (const view of this.views()) view.refreshNow();
			},
		});
		this.addCommand({
			id: "update-index",
			name: "Update vault index (changed files)",
			callback: () => void this.store.update(true),
		});
		this.addCommand({
			id: "rebuild-index",
			name: "Rebuild vault index from scratch",
			callback: () => void this.store.rebuild(),
		});

		await this.store.load();

		this.app.workspace.onLayoutReady(() => {
			// Registered here, not earlier: Obsidian fires "create" for every
			// existing file while the vault loads.
			this.registerVaultEvents();

			if (this.settings.contextPanelEnabled) {
				// On phones the sidebar is a drawer; don't pop it open at startup.
				void this.activateView(!Platform.isMobile);
			}
			// Pick up files that changed while Obsidian was closed (or synced in).
			if (!this.store.index || this.settings.indexDebounceMs > 0) {
				void this.store.update(false);
			}
		});
	}

	onunload(): void {
		void this.store.shutdown().finally(() => destroyLogger());
	}

	private registerVaultEvents(): void {
		const changed = (file: TAbstractFile, oldPath?: string) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			this.store.noteChanged(file.path);
			if (oldPath) this.store.noteChanged(oldPath);
		};
		this.registerEvent(this.app.vault.on("create", (f) => changed(f)));
		this.registerEvent(this.app.vault.on("modify", (f) => changed(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => changed(f)));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => changed(f, oldPath)));
	}

	// ── Settings ──────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		clearResolveCache();
		getLogger().updateConfig({
			enabled: this.settings.debugLogging,
			maxFileSizeBytes: this.settings.debugLogMaxSizeMB * 1024 * 1024,
		});
		this.refreshViews();
	}

	// ── Views ─────────────────────────────────────────────────

	private views(): VasoContextView[] {
		return this.app.workspace
			.getLeavesOfType(CONTEXT_VIEW_TYPE)
			.map((leaf) => leaf.view)
			.filter((v): v is VasoContextView => v instanceof VasoContextView);
	}

	/** Re-render status in every open panel (index state, settings changes). */
	refreshViews(): void {
		for (const view of this.views()) view.renderStatus();
	}

	async activateView(reveal: boolean): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(CONTEXT_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: CONTEXT_VIEW_TYPE, active: reveal });
		}
		if (reveal) await workspace.revealLeaf(leaf);
	}
}
