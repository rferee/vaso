import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { TestContext } from "node:test";
import { lmstudioProvider } from "../src/providers/lmstudio";
import type { StreamCallback } from "../src/providers/types";
import { createDefaultEndpoint } from "../src/types";

mock.method(console, "warn", () => undefined);

const ep = createDefaultEndpoint("inference", { providerType: "lmstudio", url: "http://lms.test", model: "m" });
const messages = [{ role: "user" as const, content: "Who rules the sea gate?" }];
const sse = (...events: [string, unknown][]) =>
	events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

/** Answer each fetch in this test with the next body; returns the requested URLs. */
function serve(t: TestContext, ...bodies: string[]): string[] {
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		urls.push(url);
		return new Response(bodies.shift() ?? "");
	});
	return urls;
}

function callback(): StreamCallback & { chunks: string[] } {
	const chunks: string[] = [];
	return { chunks, onStatus: () => undefined, onChunk: (t) => chunks.push(t) };
}

test("an error after partial output fails without starting the answer over", async (t) => {
	const urls = serve(
		t,
		sse(["message.delta", { content: "The Tide" }], ["error", { error: { message: "context overflow" } }]),
	);
	const cb = callback();
	await assert.rejects(lmstudioProvider.chatStream(ep, messages, cb), /LM Studio: context overflow/);
	assert.deepEqual(urls, ["http://lms.test/api/v1/chat"]);
	assert.deepEqual(cb.chunks, ["The Tide"]);
});

test("an error before any output falls back to /v1/chat/completions", async (t) => {
	const urls = serve(
		t,
		sse(["error", { error: { message: "unknown endpoint" } }]),
		`data: ${JSON.stringify({ choices: [{ delta: { content: "The Tide Queen." } }] })}\n\ndata: [DONE]\n\n`,
	);
	const result = await lmstudioProvider.chatStream(ep, messages, callback());
	assert.equal(result.text, "The Tide Queen.");
	assert.deepEqual(urls, ["http://lms.test/api/v1/chat", "http://lms.test/v1/chat/completions"]);
});
