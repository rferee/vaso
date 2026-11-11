import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { onRequest, requests } from "./obsidian-stub";
import type { StubRequest, StubResponse } from "./obsidian-stub";
import { clearResolveCache, embedTexts, resolveEmbeddingEndpoint } from "../src/llm";
import { createDefaultEndpoint, normalizeSettings } from "../src/types";

mock.method(console, "warn", () => undefined);

const endpointA = createDefaultEndpoint("embedding", { id: "a", name: "A", url: "http://a.test", model: "embed" });
const endpointB = createDefaultEndpoint("embedding", { id: "b", name: "B", url: "http://b.test", model: "embed" });

/** An Ollama server per host; `embed` answers /api/embed for the given inputs. */
function ollama(servers: Record<string, { up: boolean; embed?: (input: string[]) => StubResponse }>) {
	return (req: StubRequest): StubResponse => {
		const { host, pathname } = new URL(req.url);
		const server = servers[host];
		if (!server?.up) return { status: 503, text: "down" };
		if (pathname === "/api/tags") return { json: { models: [] } };
		if (pathname === "/api/embed" && server.embed) return server.embed((req.body as { input: string[] }).input);
		return { status: 404, text: "not found" };
	};
}

const toArray = (v: Float32Array | null) => (v ? Array.from(v, (x) => Math.round(x * 1000) / 1000) : null);

beforeEach(() => clearResolveCache());

test("only non-empty arrays of finite numbers become vectors", async () => {
	onRequest(
		ollama({
			"a.test": {
				up: true,
				embed: () => ({ json: { embeddings: [[3, 4], [1, "x"], [], { length: 1e9 }, "AAAA", [0, null]] } }),
			},
		}),
	);
	const vecs = await embedTexts(endpointA, ["a", "b", "c", "d", "e", "f"]);
	assert.deepEqual(vecs.map(toArray), [[0.6, 0.8], null, null, null, null, null]);
});

test("a failed batch is retried text by text", async () => {
	onRequest(
		ollama({
			"a.test": {
				up: true,
				embed: (input) =>
					input.length > 1 || input[0] === "bad" ? { status: 500, text: "boom" } : { json: { embeddings: [[1, 0]] } },
			},
		}),
	);
	assert.deepEqual((await embedTexts(endpointA, ["good", "bad"])).map(toArray), [[1, 0], null]);
	await assert.rejects(embedTexts(endpointA, ["bad", "bad"]), /HTTP 500/);
});

test("a failed request drops the cached endpoint so the next one is checked", async () => {
	const servers = {
		"a.test": { up: true, embed: (): StubResponse => ({ status: 500, text: "boom" }) },
		"b.test": { up: true, embed: (): StubResponse => ({ json: { embeddings: [[0, 1]] } }) },
	};
	onRequest(ollama(servers));
	const settings = normalizeSettings({ embeddingEndpoints: [endpointA, endpointB] });

	const first = await resolveEmbeddingEndpoint(settings);
	assert.equal(first.id, "a");
	await assert.rejects(embedTexts(first, ["text"]), /HTTP 500/);

	// The first endpoint went away after it was resolved.
	servers["a.test"].up = false;
	requests.length = 0;
	const next = await resolveEmbeddingEndpoint(settings);
	assert.equal(next.id, "b");
	assert.deepEqual(
		requests.map((r) => r.url),
		["http://a.test/api/tags", "http://b.test/api/tags"],
	);
});

test("a resolved endpoint stays cached while its requests succeed", async () => {
	onRequest(ollama({ "a.test": { up: true, embed: () => ({ json: { embeddings: [[1, 0]] } }) } }));
	const settings = normalizeSettings({ embeddingEndpoints: [endpointA, endpointB] });
	const ep = await resolveEmbeddingEndpoint(settings);
	await embedTexts(ep, ["text"]);
	requests.length = 0;
	assert.equal((await resolveEmbeddingEndpoint(settings)).id, "a");
	assert.equal(requests.length, 0);
});
