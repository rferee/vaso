import assert from "node:assert/strict";
import { beforeEach, describe, mock, test } from "node:test";
import type { App } from "obsidian";
import { TFile, onRequest } from "./obsidian-stub";
import type { StubRequest, StubResponse } from "./obsidian-stub";
import { indexConfigKey, isFileInScope, syncIndex } from "../src/indexer";
import type { VaultIndex } from "../src/indexer";
import { clearResolveCache } from "../src/llm";
import { createDefaultEndpoint, normalizeSettings } from "../src/types";
import type { EmbeddedChunk } from "../src/types";

mock.method(console, "warn", () => undefined);
mock.method(console, "error", () => undefined);

const endpoint = createDefaultEndpoint("embedding", { id: "e", url: "http://embed.test", model: "embed" });
const settings = normalizeSettings({ indexedDirectories: ["Lore"], embeddingEndpoints: [endpoint] });

const notes = {
	"Lore/Red.md": "The red dragon sleeps under the mountain.",
	"Lore/Blue.md": "The blue dragon guards the sea gate.",
};

function fakeApp(files: Record<string, string>, mtime: number): App {
	const byPath = new Map(Object.keys(files).map((p) => [p, new TFile(p, mtime)]));
	return {
		vault: {
			getMarkdownFiles: () => [...byPath.values()],
			getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
			cachedRead: async (f: TFile) => files[f.path as keyof typeof files]!,
		},
	} as unknown as App;
}

/** An Ollama embedding server; texts that mention "blue" get an empty vector. */
function server(up: boolean) {
	return (req: StubRequest): StubResponse => {
		if (!up) return { status: 503, text: "down" };
		const path = new URL(req.url).pathname;
		if (path === "/api/tags") return { json: { models: [] } };
		const input = (req.body as { input: string[] }).input;
		return { json: { embeddings: input.map((t) => (t.includes("blue") ? [] : [1, 0])) } };
	};
}

function chunk(filePath: string, text: string): EmbeddedChunk {
	const pageName = filePath.slice(filePath.lastIndexOf("/") + 1, -3);
	return { id: `${filePath}#0`, filePath, pageName, text, chunkIndex: 0, vector: new Float32Array([0, 1]) };
}

function oldIndex(): VaultIndex {
	return {
		chunks: [chunk("Lore/Red.md", "old red"), chunk("Lore/Blue.md", "old blue")],
		builtAt: 0,
		mtimes: { "Lore/Red.md": 1, "Lore/Blue.md": 1 },
		meta: { embeddingModel: "embed", dims: 2, configKey: indexConfigKey(settings) },
	};
}

const texts = (index: VaultIndex) => Object.fromEntries(index.chunks.map((c) => [c.filePath, c.text]));

beforeEach(() => clearResolveCache());

describe("isFileInScope", () => {
	test("root notes need indexRoot", () => {
		assert.equal(isFileInScope("Dragon.md", settings), false);
		assert.equal(isFileInScope("Dragon.md", { ...settings, indexRoot: true }), true);
	});

	test("other notes must sit under an indexed folder", () => {
		assert.equal(isFileInScope("Lore/Dragon.md", settings), true);
		assert.equal(isFileInScope("Lore/Beasts/Dragon.md", settings), true);
		assert.equal(isFileInScope("Lorem/Dragon.md", settings), false);
		assert.equal(isFileInScope("Lore/Dragon.md", { ...settings, indexedDirectories: ["/Lore/"] }), true);
		assert.equal(isFileInScope("Lore/Dragon.md", { ...settings, indexedDirectories: [""] }), false);
	});
});

describe("syncIndex", () => {
	test("an update drops deleted notes and reports the rest when no endpoint is reachable", async () => {
		onRequest(server(false));
		const app = fakeApp({ "Lore/Blue.md": notes["Lore/Blue.md"] }, 2);
		const result = await syncIndex(app, settings, oldIndex(), { paths: new Set(["Lore/Red.md", "Lore/Blue.md"]) });

		assert.equal(result.removedFiles, 1);
		assert.equal(result.embeddedFiles, 0);
		assert.deepEqual(result.failedPaths, ["Lore/Blue.md"]);
		assert.ok(result.error instanceof Error);
		assert.deepEqual(texts(result.index), { "Lore/Blue.md": "old blue" });
		assert.deepEqual(result.index.mtimes, { "Lore/Blue.md": 1 });
	});

	test("a note that could not be embedded is reported and keeps its old chunks", async () => {
		onRequest(server(true));
		const result = await syncIndex(fakeApp(notes, 2), settings, oldIndex());

		assert.equal(result.embeddedFiles, 1);
		assert.deepEqual(result.failedPaths, ["Lore/Blue.md"]);
		assert.equal(result.error, undefined);
		assert.deepEqual(texts(result.index), { "Lore/Red.md": notes["Lore/Red.md"], "Lore/Blue.md": "old blue" });
		// The failed note keeps its old mtime, so the next update retries it.
		assert.deepEqual(result.index.mtimes, { "Lore/Red.md": 2, "Lore/Blue.md": 1 });
	});
});
