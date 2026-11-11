import assert from "node:assert/strict";
import { test } from "node:test";
import type { App } from "obsidian";
import { TFile, onRequest } from "./obsidian-stub";
import type { StubRequest, StubResponse } from "./obsidian-stub";
import { IndexStore } from "../src/index-store";
import { indexConfigKey } from "../src/indexer";
import { createDefaultEndpoint, normalizeSettings } from "../src/types";
import { encodeVector } from "../src/vectors";

const endpoint = createDefaultEndpoint("embedding", { id: "e", url: "http://embed.test", model: "embed" });
const settings = normalizeSettings({ indexedDirectories: ["Lore"], embeddingEndpoints: [endpoint] });
const INDEX_FILE = "plugin/vaso-index.json";

const notes: Record<string, string> = {
	"Lore/Red.md": "The red dragon sleeps under the mountain.",
	"Lore/Blue.md": "The blue dragon guards the sea gate.",
};

/** A vault with these notes and mtimes, and an adapter that holds `files`. */
function fakeApp(mtimes: Record<string, number>, files: Record<string, string>): App {
	const byPath = new Map(Object.entries(mtimes).map(([p, m]) => [p, new TFile(p, m)]));
	return {
		vault: {
			getMarkdownFiles: () => [...byPath.values()],
			getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
			cachedRead: async (f: TFile) => notes[f.path]!,
			adapter: {
				exists: async (p: string) => p in files,
				read: async (p: string) => files[p]!,
				write: async (p: string, data: string) => {
					files[p] = data;
				},
			},
		},
	} as unknown as App;
}

function server(req: StubRequest): StubResponse {
	if (new URL(req.url).pathname === "/api/tags") return { json: { models: [] } };
	return { json: { embeddings: (req.body as { input: string[] }).input.map(() => [1, 0]) } };
}

/** A chunk as older versions stored it, with an `id`. */
const oldChunk = (filePath: string, text: string, vector: unknown) => ({
	id: `${filePath}#0`,
	filePath,
	pageName: filePath.slice(5, -3),
	text,
	chunkIndex: 0,
	vector,
});

type SavedChunk = Record<string, unknown>;
const savedChunks = (files: Record<string, string>) =>
	(JSON.parse(files[INDEX_FILE]!) as { chunks: SavedChunk[] }).chunks;

test("an update saves unchanged chunks without the old chunk ids", async () => {
	onRequest(server);
	const files = {
		[INDEX_FILE]: JSON.stringify({
			version: 2,
			builtAt: 0,
			mtimes: { "Lore/Red.md": 1, "Lore/Blue.md": 1 },
			meta: { embeddingModel: "embed", dims: 2, configKey: indexConfigKey(settings) },
			chunks: [
				oldChunk("Lore/Red.md", "old red", encodeVector(new Float32Array([0, 1]))),
				oldChunk("Lore/Blue.md", "old blue", encodeVector(new Float32Array([0, 1]))),
			],
		}),
	};
	const store = new IndexStore(fakeApp({ "Lore/Red.md": 2, "Lore/Blue.md": 1 }, files), "plugin", () => settings, () => undefined);
	await store.load();
	await store.update(false);
	await store.shutdown();

	const chunks = savedChunks(files);
	assert.deepEqual(
		chunks.map((c) => c.text),
		[notes["Lore/Red.md"], "old blue"],
	);
	for (const c of chunks) assert.deepEqual(Object.keys(c).sort(), ["chunkIndex", "filePath", "pageName", "text", "vector"]);
});

test("an index in the old format is saved in the current one, without chunk ids", async () => {
	const files = {
		[INDEX_FILE]: JSON.stringify({
			builtAt: 0,
			mtimes: { "Lore/Red.md": 1 },
			chunks: [oldChunk("Lore/Red.md", "old red", [3, 4])],
		}),
	};
	const store = new IndexStore(fakeApp({ "Lore/Red.md": 1 }, files), "plugin", () => settings, () => undefined);
	await store.load();
	assert.equal(store.chunkCount, 1);
	await store.shutdown();

	const saved = JSON.parse(files[INDEX_FILE]!) as { version: number; meta: { dims: number } };
	assert.equal(saved.version, 2);
	assert.equal(saved.meta.dims, 2);
	assert.deepEqual(savedChunks(files), [
		{
			filePath: "Lore/Red.md",
			pageName: "Red",
			text: "old red",
			chunkIndex: 0,
			vector: encodeVector(new Float32Array([0.6, 0.8])),
		},
	]);
});
