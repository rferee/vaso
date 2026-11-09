/**
 * Plain-text helpers shared by indexing, retrieval and prompt building.
 * Nothing here touches Obsidian APIs.
 */

// ── Cleaning ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const CALLOUT_START_RE = /^>\s*\[!([^\]\s]+)\]/;

export function stripFrontmatter(text: string): string {
	return text.replace(FRONTMATTER_RE, "").trim();
}

/** Length of the leading YAML frontmatter block (0 when there is none). */
export function frontmatterLength(text: string): number {
	return FRONTMATTER_RE.exec(text)?.[0].length ?? 0;
}

/** Remove callout blocks (`> [!type]` plus their quoted lines), keeping whitelisted types. */
export function stripCalloutBlocks(text: string, whitelist: string[]): string {
	const keep = new Set(whitelist.map((w) => w.toLowerCase()));
	const lines = text.split(/\r?\n/);
	const out: string[] = [];

	for (let i = 0; i < lines.length; ) {
		const match = CALLOUT_START_RE.exec(lines[i]!);
		if (!match) {
			out.push(lines[i]!);
			i++;
			continue;
		}
		let j = i + 1;
		while (j < lines.length && lines[j]!.startsWith(">")) j++;
		if (keep.has(match[1]!.toLowerCase())) out.push(...lines.slice(i, j));
		i = j;
	}

	return out.join("\n");
}

export interface CleanOptions {
	stripFrontmatter: boolean;
	stripCallouts: boolean;
	calloutWhitelist: string[];
}

/** Strip frontmatter and callouts according to settings. */
export function cleanContent(text: string, opts: CleanOptions): string {
	let out = text;
	if (opts.stripFrontmatter) out = stripFrontmatter(out);
	if (opts.stripCallouts) out = stripCalloutBlocks(out, opts.calloutWhitelist);
	return out;
}

// ── Words ────────────────────────────────────────────────────────

export function splitWords(text: string): string[] {
	return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Split text into overlapping word windows.
 * The overlap is clamped below the chunk size so the window always advances.
 */
export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
	const words = splitWords(text);
	if (words.length === 0) return [];

	const size = Math.max(1, Math.floor(chunkSize));
	const step = size - Math.min(Math.max(0, Math.floor(overlap)), size - 1);

	const chunks: string[] = [];
	for (let start = 0; start < words.length; start += step) {
		const end = Math.min(start + size, words.length);
		chunks.push(words.slice(start, end).join(" "));
		if (end >= words.length) break;
	}
	return chunks;
}

/** Keep the first `maxWords` words, marking the cut. Formatting is kept when nothing is cut. */
export function truncateWords(text: string, maxWords: number): string {
	const words = splitWords(text);
	if (words.length <= maxWords) return text;
	return words.slice(0, maxWords).join(" ") + "\n[…truncated]";
}

/** Keep the last `maxWords` words. 0 keeps everything. */
export function lastWords(text: string, maxWords: number): string {
	if (maxWords <= 0) return text;
	const words = splitWords(text);
	return words.slice(Math.max(0, words.length - maxWords)).join(" ");
}

// ── Paragraphs ───────────────────────────────────────────────────

export interface Paragraph {
	text: string;
	start: number;
	end: number;
}

/**
 * Split text into blank-line separated paragraphs, keeping character offsets
 * so cursor lookups stay correct when paragraphs repeat verbatim.
 */
export function splitParagraphs(text: string): Paragraph[] {
	const paragraphs: Paragraph[] = [];
	const sepRe = /\r?\n\s*\r?\n/g;
	let lastEnd = 0;
	let m: RegExpExecArray | null;

	const push = (start: number, end: number) => {
		const part = text.slice(start, end).trim();
		if (part.length > 0) paragraphs.push({ text: part, start, end });
	};

	while ((m = sepRe.exec(text)) !== null) {
		push(lastEnd, m.index);
		lastEnd = m.index + m[0].length;
	}
	push(lastEnd, text.length);
	return paragraphs;
}

// ── Hashing ──────────────────────────────────────────────────────

/** FNV-1a 32-bit hash as 8 hex chars. Fast and good enough for cache keys. */
export function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + "…" : s;
}
