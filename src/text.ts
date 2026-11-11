/**
 * Plain-text helpers shared by indexing, retrieval and prompt building.
 * Nothing here touches Obsidian APIs.
 */

// ── Cleaning ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n(?:---|[\s\S]*?\r?\n---)(?:\r?\n|$)/;
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

// ── Rendering ────────────────────────────────────────────────────

const ZWSP = "\u200B";
/** Leading container markers: indentation, quote markers and list markers. */
const CONTAINER = /(?:[ \t]|>|[-+*][ \t]|\d{1,9}[.)][ \t])*/.source;
/** Container markers, a fence and its info string. */
const FENCE_LINE_RE = new RegExp(`^(${CONTAINER})(\`{3,}|~{3,})(.*)$`, "s");
/**
 * Container markers before `$=` or `=` (Dataview's inline query prefixes).
 * Setext underlines of two or more `=` stay: what follows the `=` prefix then
 * starts with `=`, which no query does.
 */
const QUERY_LINE_RE = new RegExp(`^(${CONTAINER})(?=\\$=|=(?!=+[ \\t]*$))`);

/**
 * Angle brackets. A URI autolink stays: as HTML its tag name would hold a `:`,
 * so it can't become an element. An inline link or reference definition with
 * an angle-bracket destination ([Source](<Some Note.md>)) is rewritten to the
 * percent-encoded form, which leaves no `<` even where it isn't a link. Any
 * other `<` before a tag name gets a zero-width space.
 */
const ANGLE_RE = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|(\[[^\]<`]*\]\(|^ {0,3}\[[^\]<`]+\]:[ \t]*)<([^<>`]*)>|<(?=[A-Za-z/!?])/g;

const percentEncode = (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");

/** Code spans start with a zero-width space; `<tag` and `![` are broken up rather than deleted, so none can re-form. */
function inertInline(text: string): string {
	return text
		.replace(/`+/g, "$&" + ZWSP)
		.replace(ANGLE_RE, (m, head?: string, dest?: string) =>
			head !== undefined ? head + dest!.replace(/[ \t()]/g, percentEncode) : m === "<" ? "<" + ZWSP : m,
		)
		.replace(/!\[/g, "!" + ZWSP + "[");
}

/**
 * Make model output inert before MarkdownRenderer, which runs every
 * registered code-block and post processor and loads remote media while it
 * renders. A zero-width space goes in front of every fence's info string, so
 * no code-block processor (dataviewjs, …) matches the language, and at the
 * start of code spans and code blocks, so inline query prefixes (`= …`,
 * `$= …`) don't match. `![` and `<` before a tag name get one too, so no
 * image, embed or HTML element is created. Which lines are fences never
 * changes, and every line is neutralised whether or not it is inside a fence.
 */
export function inertMarkdown(markdown: string): string {
	const out: string[] = [];
	let fence: { ch: string; len: number } | null = null;
	let codeStart = false;

	// All Markdown line endings: a bare CR also ends a line.
	for (const line of markdown.split(/\r\n?|\n/)) {
		const m = FENCE_LINE_RE.exec(line);
		const prefix = m?.[1] ?? "";
		const run = m?.[2] ?? "";
		const info = m?.[3] ?? "";
		// A backtick in a backtick fence's info string makes it a code span instead.
		if (m && !(run[0] === "`" && info.includes("`"))) {
			if (fence && run[0] === fence.ch && run.length >= fence.len && !info.trim()) {
				fence = null;
			} else if (!fence) {
				fence = { ch: run[0]!, len: run.length };
				codeStart = true;
			} else {
				codeStart = false; // code that starts with a fence run matches no prefix
			}
			// The info string may also be code content or paragraph text.
			out.push(info.trim() ? prefix + run + ZWSP + inertInline(info) : line);
			continue;
		}

		let l = inertInline(line);
		if (fence && codeStart && l.trim()) {
			// First line of a code block: no prefix may match its text either.
			codeStart = false;
			l = l.replace(/^[ \t>]*/, "$&" + ZWSP);
		} else {
			l = l.replace(QUERY_LINE_RE, "$1" + ZWSP);
		}
		out.push(l);
	}
	return out.join("\n");
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
