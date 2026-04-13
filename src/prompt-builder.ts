import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { SearchResult, EmbeddedChunk, VasoSettings } from "./types";
import type { ChatMessage } from "./llm";
import { stripFrontmatter } from "./indexer";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Strip Obsidian callout blocks from text, preserving whitelisted types.
 */
function stripCalloutBlocks(text: string, whitelist: string[]): string {
	const wl = new Set(whitelist.map((w) => w.toLowerCase()));
	const lines = text.split("\n");
	const result: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		const match = line.match(/^>\s*\[!(\w+)\]/);
		if (match) {
			const calloutType = match[1]!.toLowerCase();
			const blockLines: string[] = [line];
			let j = i + 1;
			while (j < lines.length && /^>/.test(lines[j]!)) {
				blockLines.push(lines[j]!);
				j++;
			}
			if (wl.has(calloutType)) {
				result.push(...blockLines);
			}
			i = j;
		} else {
			result.push(line);
			i++;
		}
	}

	return result.join("\n");
}

/** Clean content for LLM: strip frontmatter and callouts per settings. */
export function cleanContent(
	text: string,
	settings: Pick<VasoSettings, "stripFrontmatter" | "stripCallouts" | "calloutWhitelist">
): string {
	let out = text;
	if (settings.stripFrontmatter) {
		out = stripFrontmatter(out);
	}
	if (settings.stripCallouts) {
		out = stripCalloutBlocks(out, settings.calloutWhitelist);
	}
	return out;
}

// ── Context builders ─────────────────────────────────────────────

/** Build context from chunk text only. */
export function buildChunkContext(results: SearchResult[]): string {
	const parts: string[] = [];
	for (const r of results) {
		parts.push(`**[[${r.chunk.pageName}]]:**\n${r.chunk.text}`);
	}
	return parts.join("\n\n");
}

/** Build context from full source pages (L1). */
export async function buildFullPageContext(
	results: SearchResult[],
	app: App,
	settings: Pick<VasoSettings, "l1MaxPageWords" | "stripFrontmatter" | "stripCallouts" | "calloutWhitelist">
): Promise<string> {
	const parts: string[] = [];
	const maxWords = settings.l1MaxPageWords;

	for (const r of results) {
		const file = app.vault.getAbstractFileByPath(r.chunk.filePath);
		if (!file || !(file instanceof TFile)) continue;

		let content = await app.vault.cachedRead(file);
		content = cleanContent(content, settings);

		const words = content.split(/\s+/);
		if (words.length > maxWords) {
			content = words.slice(0, maxWords).join(" ") + "\n[…truncated]";
		}

		parts.push(`### [[${r.chunk.pageName}]]\n${content}`);
	}

	return parts.join("\n\n---\n\n");
}

/**
 * Build L0 context according to l0Depth setting.
 * - "chunk": matched chunk text only
 * - "nearby": matched chunk ± l0NearbyRadius surrounding chunks
 * - "page": full source page
 */
export async function buildL0Context(
	results: SearchResult[],
	app: App,
	settings: Pick<VasoSettings, "l0Depth" | "l0NearbyRadius" | "l1MaxPageWords" | "stripFrontmatter" | "stripCallouts" | "calloutWhitelist">,
	indexChunks: EmbeddedChunk[]
): Promise<string> {
	const depth = settings.l0Depth;

	if (depth === "page") {
		return buildFullPageContext(results, app, settings);
	}

	if (depth === "nearby") {
		const radius = settings.l0NearbyRadius;
		const parts: string[] = [];

		for (const r of results) {
			const siblings = indexChunks
				.filter((c) => c.filePath === r.chunk.filePath)
				.sort((a, b) => a.chunkIndex - b.chunkIndex);

			const minIdx = Math.max(0, r.chunk.chunkIndex - radius);
			const maxIdx = r.chunk.chunkIndex + radius;

			const nearby = siblings
				.filter((c) => c.chunkIndex >= minIdx && c.chunkIndex <= maxIdx)
				.map((c) => c.text);

			parts.push(`**[[${r.chunk.pageName}]]:**\n${nearby.join("\n\n")}`);
		}

		return parts.join("\n\n");
	}

	return buildChunkContext(results);
}

// ── Cache key ────────────────────────────────────────────────────

/** Build a deterministic cache key from the search results. */
export function buildCacheKey(l0: SearchResult[], l1: SearchResult[], l2: SearchResult[]): string {
	const ids = [
		...l0.map((r) => `0:${r.chunk.id}`),
		...l1.map((r) => `1:${r.chunk.id}`),
		...l2.map((r) => `2:${r.chunk.id}`),
	];
	ids.sort();
	return ids.join("|");
}

// ── Prompt assembly ──────────────────────────────────────────────

/** Assemble the LLM messages from search results and writing context. */
export function buildMessages(
	systemPrompt: string,
	writingContext: string,
	cursorParagraph: string | null,
	l0Context: string,
	l1Context: string,
	l2Context: string
): ChatMessage[] {
	let userContent = "";

	if (cursorParagraph) {
		userContent += `## Paragraph the user is currently editing:\n**${cursorParagraph}**\n\n`;
	}

	userContent += `## Writing context:\n${writingContext}\n\n`;

	if (l0Context.length > 0) {
		userContent += `## Most relevant lore (paragraph-matched):\n${l0Context}\n\n`;
	}
	if (l1Context.length > 0) {
		userContent += `## Lore pages (note-matched):\n${l1Context}\n\n`;
	}
	if (l2Context.length > 0) {
		userContent += `## Additional lore excerpts:\n${l2Context}`;
	}

	return [
		{ role: "system" as const, content: systemPrompt },
		{ role: "user" as const, content: userContent },
	];
}
