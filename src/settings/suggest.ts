import { FuzzySuggestModal, Modal, Setting, SuggestModal, prepareFuzzySearch } from "obsidian";
import type { App, TFolder } from "obsidian";
import type { ModelEntry } from "../llm";

/** Searchable model list; whatever is typed can be used as a model name too. */
export class ModelSuggestModal extends SuggestModal<ModelEntry & { custom?: boolean }> {
	constructor(
		app: App,
		private models: ModelEntry[],
		private onChoose: (modelId: string) => void,
		loadError?: string,
	) {
		super(app);
		this.setPlaceholder(models.length ? "Search models or type a name" : "Type a model name");
		this.emptyStateText = loadError ? `Couldn't load models: ${loadError}` : "No models found.";
	}

	getSuggestions(query: string): (ModelEntry & { custom?: boolean })[] {
		const q = query.trim();
		let out: (ModelEntry & { custom?: boolean })[] = this.models;
		if (q) {
			const match = prepareFuzzySearch(q);
			out = this.models
				.map((m) => ({ m, r: match(`${m.id} ${m.name}`) }))
				.filter((x) => x.r !== null)
				.sort((a, b) => b.r!.score - a.r!.score)
				.map((x) => x.m);
			if (!this.models.some((m) => m.id === q)) out = [{ id: q, name: `Use "${q}"`, custom: true }, ...out];
		}
		return out.slice(0, 300);
	}

	renderSuggestion(m: ModelEntry & { custom?: boolean }, el: HTMLElement): void {
		el.createDiv({ text: m.name });
		const ctx = m.contextLength ? `${Math.round(m.contextLength / 1024)}k context` : "";
		const meta = [m.custom || m.id === m.name ? "" : m.id, m.parameterSize ?? "", ctx].filter(Boolean).join(" · ");
		if (meta) el.createEl("small", { cls: "vaso-suggest-meta", text: meta });
	}

	onChooseSuggestion(m: ModelEntry): void {
		this.onChoose(m.id);
	}
}

/** Pick a vault folder. */
export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private exclude: Set<string>,
		private onChoose: (path: string) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a folder to index");
	}

	getItems(): TFolder[] {
		return this.app.vault
			.getAllFolders(false)
			.filter((f) => !this.exclude.has(f.path))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder.path);
	}
}

/** Yes/no question with a destructive confirm button. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		title: string,
		private message: string,
		private confirmText: string,
		private onConfirm: () => void,
	) {
		super(app);
		this.setTitle(title);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.confirmText)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
