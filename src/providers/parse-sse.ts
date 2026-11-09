/**
 * Server-Sent Events parser for OpenRouter, LM Studio and OpenAI-compatible
 * streams. Handles `event:`, `data:` and `:` comment lines, with LF, CRLF or
 * CR line endings, across arbitrary network chunk boundaries.
 */

export interface SSEEvent {
	/** Event name from `event:` (empty when absent). */
	event: string;
	/** Concatenated `data:` lines. */
	data: string;
	/** Comment text from `:` lines (undefined when absent). */
	comment?: string;
}

/**
 * Parse the complete events in `buffer`. The remainder (an incomplete event)
 * must be prepended to the next chunk.
 */
export function parseSSE(buffer: string): { events: SSEEvent[]; remainder: string } {
	// A trailing CR may be the first half of a CRLF split across chunks.
	const held = buffer.endsWith("\r") ? "\r" : "";
	const text = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");

	const blocks = text.split("\n\n");
	const remainder = (blocks.pop() ?? "") + held;
	const events: SSEEvent[] = [];

	for (const block of blocks) {
		if (block.trim().length === 0) continue;
		let event = "";
		let comment: string | undefined;
		const dataLines: string[] = [];

		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
			else if (line.startsWith(":")) comment = line.slice(1).trim();
		}

		const data = dataLines.join("\n");
		if (data.length > 0 || comment !== undefined) events.push({ event, data, comment });
	}

	return { events, remainder };
}

export function isSSEDone(data: string): boolean {
	return data.trim() === "[DONE]";
}
