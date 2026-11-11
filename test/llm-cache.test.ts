import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataAdapter } from "obsidian";
import { LLMCache } from "../src/llm-cache";

/** An adapter whose writes finish only when the test says so. */
function slowAdapter() {
	const writes: { data: string; finish: () => void }[] = [];
	let running = 0;
	let maxRunning = 0;
	const adapter = {
		exists: async () => false,
		write: (_path: string, data: string) =>
			new Promise<void>((resolve) => {
				running++;
				maxRunning = Math.max(maxRunning, running);
				writes.push({
					data,
					finish: () => {
						running--;
						resolve();
					},
				});
			}),
	};
	return { adapter: adapter as unknown as DataAdapter, writes, maxRunning: () => maxRunning };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a change made while the cache is written is saved by the next save", async () => {
	const { adapter, writes, maxRunning } = slowAdapter();
	const cache = new LLMCache(adapter, "plugin");

	cache.set("Lore/A.md", "k1", "first");
	const firstSave = cache.save();
	await tick();
	assert.equal(writes.length, 1);

	cache.set("Lore/B.md", "k2", "second");
	const secondSave = cache.save();
	await tick();
	// The second write waits for the first one.
	assert.equal(writes.length, 1);

	writes[0]!.finish();
	await firstSave;
	await tick();
	assert.equal(writes.length, 2);
	assert.deepEqual(Object.keys(JSON.parse(writes[1]!.data)), ["Lore/A.md", "Lore/B.md"]);
	writes[1]!.finish();
	await secondSave;

	// Nothing changed since: no further write.
	await cache.save();
	assert.equal(writes.length, 2);
	assert.equal(maxRunning(), 1);
});

test("a write that started before a change does not mark the change saved", async () => {
	const { adapter, writes } = slowAdapter();
	const cache = new LLMCache(adapter, "plugin");

	cache.set("Lore/A.md", "k1", "first");
	const save = cache.save();
	await tick();
	cache.set("Lore/A.md", "k2", "updated");
	writes[0]!.finish();
	await save;

	const next = cache.save();
	await tick();
	assert.equal(writes.length, 2);
	assert.equal(JSON.parse(writes[1]!.data)["Lore/A.md"].response, "updated");
	writes[1]!.finish();
	await next;
});
