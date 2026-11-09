import type { EmbeddedChunk, SearchResult } from "./types";
import { dot } from "./vectors";
import type { Vector } from "./vectors";
import { getLogger } from "./logger";

export interface ThreeLayerResult {
	/** L0: paragraph-focused chunks (only when a cursor is available). */
	l0: SearchResult[];
	/** L1: whole-note relevant — full source pages will be sent. */
	l1: SearchResult[];
	/** L2: broad context — chunk text only. */
	l2: SearchResult[];
}

export interface SearchCounts {
	l0: number;
	l1: number;
	l2: number;
}

/**
 * Three-layer semantic search over unit vectors (dot product = cosine).
 *
 * L0: Top chunks by similarity to the cursor paragraph, one per page.
 * L1: Top pages by max similarity to any chunk of the current note, one
 *     chunk per page, skipping L0 pages.
 * L2: The next chunks down the L1 ranking from pages not in L0 or L1.
 */
export function threeLayerSearch(
	l0Query: Vector | null,
	noteVecs: Vector[],
	index: EmbeddedChunk[],
	counts: SearchCounts,
	excludeFilePath?: string,
): ThreeLayerResult {
	const log = getLogger();
	const dims = index[0]?.vector.length ?? 0;
	const usable = (v: Vector) => v.length === dims;
	if ((l0Query && !usable(l0Query)) || noteVecs.some((v) => !usable(v))) {
		throw new Error(
			`Embedding size mismatch: the index has ${dims} dimensions but the query has ` +
				`${(l0Query ?? noteVecs[0])?.length}. Rebuild the index.`,
		);
	}

	const candidates = excludeFilePath
		? index.filter((c) => c.filePath !== excludeFilePath)
		: index;

	// ── L0 ──
	const l0: SearchResult[] = [];
	const l0Pages = new Set<string>();
	if (l0Query && counts.l0 > 0) {
		const scored = rank(candidates, (c) => dot(l0Query, c.vector));
		logTop(scored, Math.max(counts.l0 + 3, 8), "L0 paragraph-focused");
		for (const r of scored) {
			if (l0.length >= counts.l0) break;
			if (l0Pages.has(r.chunk.filePath)) continue;
			l0.push(r);
			l0Pages.add(r.chunk.filePath);
		}
	}

	// ── L1 + L2 ──
	const l1: SearchResult[] = [];
	const l2: SearchResult[] = [];
	const l1Pages = new Set<string>();
	if (noteVecs.length > 0 && counts.l1 + counts.l2 > 0) {
		const scored = rank(candidates, (c) => {
			let max = 0;
			for (const q of noteVecs) max = Math.max(max, dot(q, c.vector));
			return max;
		});
		logTop(scored, Math.max(counts.l1 + counts.l2 + 5, 12), "L1/L2 whole-note");

		for (const r of scored) {
			if (l1.length >= counts.l1) break;
			const p = r.chunk.filePath;
			if (l0Pages.has(p) || l1Pages.has(p)) continue;
			l1.push(r);
			l1Pages.add(p);
		}
		for (const r of scored) {
			if (l2.length >= counts.l2) break;
			const p = r.chunk.filePath;
			if (l0Pages.has(p) || l1Pages.has(p)) continue;
			l2.push(r);
		}
	}

	log.info("search", `Selected L0=${l0.length} L1=${l1.length} L2=${l2.length} from ${candidates.length} chunks`);
	return { l0, l1, l2 };
}

function rank(chunks: EmbeddedChunk[], score: (c: EmbeddedChunk) => number): SearchResult[] {
	return chunks
		.map((chunk) => ({ chunk, similarity: score(chunk) }))
		.sort((a, b) => b.similarity - a.similarity);
}

function logTop(scored: SearchResult[], n: number, label: string): void {
	const log = getLogger();
	if (!log.debugEnabled) return;
	log.debug("search", `── ${label} (top ${n}) ──`);
	for (const r of scored.slice(0, n)) {
		log.debug(
			"search",
			`  ${(r.similarity * 100).toFixed(1)}%  [[${r.chunk.pageName}]]  "${r.chunk.text.slice(0, 80)}…"`,
		);
	}
}
