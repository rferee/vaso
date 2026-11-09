import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { SearchResult, EmbeddedChunk, VasoSettings } from "./types";
import type { ChatMessage } from "./llm";
import { cleanContent, hashString, truncateWords } from "./text";

// ── Context builders ─────────────────────────────────────────────

type PageSettings = Pick<
	VasoSettings,
	"l1MaxPageWords" | "stripFrontmatter" | "stripCallouts" | "calloutWhitelist"
>;

/** Matched chunk text only (L2, and L0 at chunk depth). */
export function buildChunkContext(results: SearchResult[]): string {
	return results.map((r) => `**[[${r.chunk.pageName}]]:**\n${r.chunk.text}`).join("\n\n");
}

/** Full source pages, cleaned and truncated (L1, and L0 at page depth). */
export async function buildFullPageContext(
	results: SearchResult[],
	app: App,
	settings: PageSettings,
): Promise<string> {
	const parts: string[] = [];
	for (const r of results) {
		const file = app.vault.getAbstractFileByPath(r.chunk.filePath);
		if (!(file instanceof TFile)) continue;
		const content = cleanContent(await app.vault.cachedRead(file), settings);
		parts.push(`### [[${r.chunk.pageName}]]\n${truncateWords(content, settings.l1MaxPageWords)}`);
	}
	return parts.join("\n\n---\n\n");
}

/** L0 context at the configured depth: chunk, chunk ± radius, or full page. */
export async function buildL0Context(
	results: SearchResult[],
	app: App,
	settings: PageSettings & Pick<VasoSettings, "l0Depth" | "l0NearbyRadius">,
	indexChunks: EmbeddedChunk[],
): Promise<string> {
	if (settings.l0Depth === "page") return buildFullPageContext(results, app, settings);
	if (settings.l0Depth === "chunk") return buildChunkContext(results);

	const radius = settings.l0NearbyRadius;
	const wanted = new Set(results.map((r) => r.chunk.filePath));
	const siblings = new Map<string, EmbeddedChunk[]>();
	for (const c of indexChunks) {
		if (!wanted.has(c.filePath)) continue;
		const arr = siblings.get(c.filePath);
		if (arr) arr.push(c);
		else siblings.set(c.filePath, [c]);
	}

	return results
		.map((r) => {
			const lo = r.chunk.chunkIndex - radius;
			const hi = r.chunk.chunkIndex + radius;
			const nearby = (siblings.get(r.chunk.filePath) ?? [])
				.filter((c) => c.chunkIndex >= lo && c.chunkIndex <= hi)
				.sort((a, b) => a.chunkIndex - b.chunkIndex)
				.map((c) => c.text);
			return `**[[${r.chunk.pageName}]]:**\n${nearby.join("\n\n")}`;
		})
		.join("\n\n");
}

// ── Template ─────────────────────────────────────────────────────

export interface PromptVars {
	/** Title of the note being written. */
	title: string;
	/** Paragraph under the cursor (empty when there's no editor). */
	paragraph: string;
	/** Tail of the current note. */
	writing: string;
	l0: string;
	l1: string;
	l2: string;
}

export const TEMPLATE_VARIABLES: Record<keyof PromptVars, string> = {
	title: "Title of the note you're writing",
	paragraph: "Paragraph under the cursor",
	writing: "The current note (last N words, per Writing context)",
	l0: "Lore matched to the cursor paragraph",
	l1: "Full lore pages matched to the whole note",
	l2: "Extra lore excerpts",
};

/**
 * Render a user-prompt template.
 *
 * `{{name}}` inserts a variable. `{{#name}}…{{/name}}` keeps its contents only
 * when the variable is non-empty. Runs of blank lines left behind by empty
 * sections collapse to one; inserted text is never re-scanned or altered.
 */
export function renderTemplate(template: string, vars: PromptVars): string {
	const value = (name: string) =>
		Object.prototype.hasOwnProperty.call(vars, name) ? vars[name as keyof PromptVars] : undefined;

	const withSections = template.replace(
		/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
		(_m, name: string, inner: string) => (value(name)?.trim() ? inner : ""),
	);
	const tidy = withSections.replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, "\n\n").trim();
	return tidy.replace(/\{\{(\w+)\}\}/g, (m, name: string) => value(name) ?? m);
}

export function buildMessages(systemPrompt: string, template: string, vars: PromptVars): ChatMessage[] {
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: renderTemplate(template, vars) },
	];
}

// ── Cache key ────────────────────────────────────────────────────

/**
 * Cache key for a synthesis. It covers the prompts and the retrieved lore
 * text (so edited sources or prompts invalidate it), but not the note being
 * written: reopening a note replays the last answer while its sources match.
 */
export function buildCacheKey(
	settings: Pick<VasoSettings, "systemPrompt" | "userPromptTemplate">,
	vars: Pick<PromptVars, "l0" | "l1" | "l2">,
): string {
	return hashString(
		[settings.systemPrompt, settings.userPromptTemplate, vars.l0, vars.l1, vars.l2].join("\u0000"),
	);
}
