import type { EmbeddedChunk, SearchResult } from "./types";
import { getLogger } from "./logger";

/** Cosine similarity between two vectors. */
export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < a.length; i++) {
		const ai = a[i] ?? 0;
		const bi = b[i] ?? 0;
		dot += ai * bi;
		magA += ai * ai;
		magB += bi * bi;
	}
	const denom = Math.sqrt(magA) * Math.sqrt(magB);
	return denom === 0 ? 0 : dot / denom;
}

export interface ThreeLayerResult {
	/** L0: paragraph-focused chunks (only when cursor available). */
	l0: SearchResult[];
	/** L1: whole-note relevant — full source pages will be sent. */
	l1: SearchResult[];
	/** L2: broad context — chunk text only. */
	l2: SearchResult[];
}

/**
 * Three-layer semantic search.
 *
 * L0: Score index by cosine(l0QueryVec, chunk). Top l0Count chunks, dedup by page.
 *     Only used when l0QueryVec is provided (cursor available).
 *
 * L1: For each indexed chunk, compute max cosine similarity across all
 *     noteChunkVecs. Top l1Count by that max score, dedup by page,
 *     excluding pages already in L0.
 *
 * L2: Continue down the L1 ranked list, next l2Count chunks,
 *     excluding pages in L0 and L1.
 */
export function threeLayerSearch(
	l0QueryVec: number[] | null,
	noteChunkVecs: number[][],
	index: EmbeddedChunk[],
	l0Count: number,
	l1Count: number,
	l2Count: number,
	excludeFilePath?: string
): ThreeLayerResult {
	const log = getLogger();

	// Filter out the current file
	const candidates = excludeFilePath
		? index.filter((c) => c.filePath !== excludeFilePath)
		: index;

	// ── L0: paragraph-focused ────────────────────────────────
	const l0: SearchResult[] = [];
	const l0Pages = new Set<string>();

	if (l0QueryVec && l0Count > 0) {
		const l0Scored: SearchResult[] = candidates.map((chunk) => ({
			chunk,
			similarity: cosine(l0QueryVec, chunk.vector),
		}));
		l0Scored.sort((a, b) => b.similarity - a.similarity);
		log.debug("search", `── L0 paragraph-focused search (top ${l0Count} chunks, ${candidates.length} candidates) ──`);
		const l0Preview = l0Scored.slice(0, Math.max(l0Count + 3, 8));
		for (const r of l0Preview) {
			log.debug("search", `  ${(r.similarity * 100).toFixed(1)}%  [[${r.chunk.pageName}]]  "${r.chunk.text.slice(0, 80)}…"`);
		}

		for (const r of l0Scored) {
			if (l0.length >= l0Count) break;
			if (l0Pages.has(r.chunk.filePath)) continue;
			l0.push(r);
			l0Pages.add(r.chunk.filePath);
		}
		log.info("search", `→ selected ${l0.length} L0 chunks from ${l0Pages.size} pages`);
	}

	// ── L1 + L2: whole-note relevance ────────────────────────
	// For each indexed chunk, compute max similarity across all note chunks.
	const l1Scored: SearchResult[] = [];

	if (noteChunkVecs.length > 0) {
		for (const chunk of candidates) {
			let maxSim = 0;
			for (const qv of noteChunkVecs) {
				const sim = cosine(qv, chunk.vector);
				if (sim > maxSim) maxSim = sim;
			}
			l1Scored.push({ chunk, similarity: maxSim });
		}
		l1Scored.sort((a, b) => b.similarity - a.similarity);
	}

	// L1: top N by max-similarity, dedup by page, excluding L0 pages
	const l1: SearchResult[] = [];
	const l1Pages = new Set<string>();

	if (l1Scored.length > 0) {
		log.debug("search", `── L1 whole-note relevance (top ${l1Count} pages, max-similarity across ${noteChunkVecs.length} note chunks) ──`);
		const l1Preview = l1Scored.slice(0, Math.max(l1Count + l2Count + 5, 12));
		for (const r of l1Preview) {
			const skipped = l0Pages.has(r.chunk.filePath) ? " [skip: in L0]" : "";
			log.debug("search", `  ${(r.similarity * 100).toFixed(1)}%  [[${r.chunk.pageName}]]  "${r.chunk.text.slice(0, 80)}…"${skipped}`);
		}
	}

	for (const r of l1Scored) {
		if (l1.length >= l1Count) break;
		if (l0Pages.has(r.chunk.filePath)) continue;
		if (l1Pages.has(r.chunk.filePath)) continue;
		l1.push(r);
		l1Pages.add(r.chunk.filePath);
	}
	log.info("search", `→ selected ${l1.length} L1 pages: ${[...l1Pages].map((p) => "[[" + p.replace(/\.md$/, "").split("/").pop() + "]]").join(", ")}`);

	// L2: continue down the list, excluding L0 + L1 pages
	const excludedPages = new Set([...l0Pages, ...l1Pages]);
	const l2: SearchResult[] = [];

	for (const r of l1Scored) {
		if (l2.length >= l2Count) break;
		if (excludedPages.has(r.chunk.filePath)) continue;
		l2.push(r);
	}
	log.info("search", `→ selected ${l2.length} L2 chunks (broad context)`);

	return { l0, l1, l2 };
}