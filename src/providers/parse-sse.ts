/**
 * Server-Sent Events (SSE) line parser.
 *
 * Used by OpenRouter, LM Studio, and OpenAI-compatible providers.
 * Handles standard SSE format: `data:`, `event:`, and `:` (comment) lines,
 * separated by double-newline boundaries.
 */

/** A single parsed SSE event. */
export interface SSEEvent {
	/** Event name from `event:` line (empty string if none). */
	event: string;
	/** Data payload (concatenated `data:` lines). */
	data: string;
	/** Comment text from `:` lines (undefined if none). */
	comment?: string;
}

/**
 * Incrementally parse SSE events from a text buffer.
 *
 * Returns the parsed events and the unparsed remainder (which may contain
 * an incomplete event waiting for more data).
 *
 * @example
 * ```ts
 * buffer += decoder.decode(chunk, { stream: true });
 * const { events, remainder } = parseSSE(buffer);
 * buffer = remainder;
 * for (const ev of events) { ... }
 * ```
 */
export function parseSSE(buffer: string): {
	events: SSEEvent[];
	remainder: string;
} {
	const events: SSEEvent[] = [];
	const blocks = buffer.split("\n\n");
	// Last block may be incomplete — keep it as remainder
	const remainder = blocks.pop() ?? "";

	for (const block of blocks) {
		if (block.trim().length === 0) continue;

		let event = "";
		const dataLines: string[] = [];
		let comment: string | undefined;

		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				// SSE spec: optional single space after colon
				dataLines.push(line.slice(5).replace(/^ /, ""));
			} else if (line.startsWith(":")) {
				// Comment line — used by OpenRouter for processing status
				comment = line.slice(1).trim();
			}
			// Lines without a known field prefix are ignored per SSE spec
		}

		const data = dataLines.join("\n");

		if (data.length > 0 || comment !== undefined) {
			events.push({ event, data, comment });
		}
	}

	return { events, remainder };
}

/** Check if an SSE data payload is the `[DONE]` sentinel. */
export function isSSEDone(data: string): boolean {
	return data.trim() === "[DONE]";
}
