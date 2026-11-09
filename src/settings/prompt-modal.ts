import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

export interface PromptModalOptions {
	title: string;
	description: string;
	value: string;
	defaultValue: string;
	/** Template variables shown as insertable chips (name → description). */
	variables?: Record<string, string>;
	onSave: (value: string) => void;
}

/** Full-size editor for a prompt; changes apply on Save only. */
export class PromptModal extends Modal {
	private textarea!: HTMLTextAreaElement;

	constructor(
		app: App,
		private opts: PromptModalOptions,
	) {
		super(app);
		this.setTitle(opts.title);
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		this.modalEl.addClass("vaso-prompt-modal");
		contentEl.createEl("p", { cls: "setting-item-description", text: opts.description });

		if (opts.variables) {
			const chips = contentEl.createDiv("vaso-chips");
			for (const [name, desc] of Object.entries(opts.variables)) {
				const chip = chips.createEl("button", { cls: "vaso-chip", text: `{{${name}}}`, attr: { "aria-label": desc } });
				chip.addEventListener("click", () => this.insert(`{{${name}}}`));
			}
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: "Tap a variable to insert it. Wrap text in {{#name}} … {{/name}} to include it only when that variable has content.",
			});
		}

		this.textarea = contentEl.createEl("textarea", {
			cls: "vaso-prompt-textarea",
			attr: { spellcheck: "false", rows: "16" },
		});
		this.textarea.value = opts.value;

		const count = contentEl.createDiv({ cls: "vaso-prompt-count" });
		const updateCount = () => {
			const n = this.textarea.value.length;
			count.setText(`${n.toLocaleString()} characters · ~${Math.ceil(n / 4).toLocaleString()} tokens`);
		};
		this.textarea.addEventListener("input", updateCount);
		updateCount();

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Reset to default").onClick(() => {
					this.textarea.value = opts.defaultValue;
					updateCount();
				}),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						opts.onSave(this.textarea.value);
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private insert(text: string): void {
		const ta = this.textarea;
		const start = ta.selectionStart ?? ta.value.length;
		const end = ta.selectionEnd ?? start;
		ta.setRangeText(text, start, end, "end");
		ta.focus();
		ta.dispatchEvent(new Event("input"));
	}
}
