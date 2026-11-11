import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TestContext } from "node:test";
import { onRequest, requests } from "./obsidian-stub";
import { lmstudioProvider } from "../src/providers/lmstudio";
import { ollamaProvider } from "../src/providers/ollama";
import { openaiCompatProvider } from "../src/providers/openai-compat";
import { openrouterProvider } from "../src/providers/openrouter";
import type { LLMProvider, StreamCallback } from "../src/providers/types";
import { createDefaultEndpoint } from "../src/types";
import type { ProviderType } from "../src/types";

const endpoint = (providerType: ProviderType, url: string, type: "embedding" | "inference" = "inference") =>
	createDefaultEndpoint(type, { providerType, url, model: "m", apiKey: "test-key" });
const messages = [{ role: "user" as const, content: "Who rules the sea gate?" }];
const quiet: StreamCallback = { onStatus: () => undefined, onChunk: () => undefined };

/** Answer the single fetch in this test with `body`. */
function serve(t: TestContext, body: string): void {
	t.mock.method(globalThis, "fetch", async () => new Response(body));
}

describe("model lists", () => {
	test("Ollama", async () => {
		onRequest(() => ({
			json: { models: [{ name: "qwen3:8b", model: "qwen3:8b", details: { family: "qwen3", parameter_size: "8.2B" } }] },
		}));
		assert.deepEqual(await ollamaProvider.listModels(endpoint("ollama", "http://ollama.test")), [
			{ id: "qwen3:8b", name: "qwen3:8b", parameterSize: "8.2B" },
		]);
	});

	test("OpenRouter", async () => {
		onRequest(() => ({ json: { data: [{ id: "acme/tide-7b", name: "Acme: Tide 7B", context_length: 32768 }] } }));
		assert.deepEqual(await openrouterProvider.listModels(endpoint("openrouter", "https://openrouter.test/api/v1")), [
			{ id: "acme/tide-7b", name: "Acme: Tide 7B", contextLength: 32768 },
		]);
	});

	test("OpenAI-compatible", async () => {
		onRequest(() => ({ json: { data: [{ id: "tide", owned_by: "acme" }, { owned_by: "nobody" }] } }));
		assert.deepEqual(await openaiCompatProvider.listModels(endpoint("openai-compat", "http://vllm.test")), [
			{ id: "tide", name: "tide" },
		]);
	});

	test("LM Studio", async () => {
		onRequest(() => ({
			json: {
				models: [
					{ key: "tide-7b", type: "llm", display_name: "Tide 7B", publisher: "acme", max_context_length: 8192, params_string: "7B" },
					{ key: "embed-small", type: "embedding" },
				],
			},
		}));
		assert.deepEqual(await lmstudioProvider.listModels(endpoint("lmstudio", "http://lms.test")), [
			{ id: "tide-7b", name: "Tide 7B", contextLength: 8192, parameterSize: "7B", kind: "llm" },
		]);
	});
});

describe("chat token counts", () => {
	test("Ollama reads them from the final line", async (t) => {
		serve(
			t,
			[
				{ message: { content: "The Tide " } },
				{ message: { content: "Queen." } },
				{ done: true, prompt_eval_count: 120, eval_count: 4, total_duration: 1_500_000_000 },
			]
				.map((l) => JSON.stringify(l))
				.join("\n"),
		);
		const result = await ollamaProvider.chatStream(endpoint("ollama", "http://ollama.test"), messages, quiet);
		assert.deepEqual(result, { text: "The Tide Queen.", stats: { promptTokens: 120, responseTokens: 4 } });
	});

	test("OpenAI-style streams read them from usage", async (t) => {
		serve(
			t,
			[
				{ choices: [{ delta: { content: "The Tide Queen." } }] },
				{ choices: [], usage: { prompt_tokens: 120, completion_tokens: 4 } },
			]
				.map((e) => `data: ${JSON.stringify(e)}\n\n`)
				.join("") + "data: [DONE]\n\n",
		);
		const result = await openaiCompatProvider.chatStream(endpoint("openai-compat", "http://vllm.test"), messages, quiet);
		assert.deepEqual(result, { text: "The Tide Queen.", stats: { promptTokens: 120, responseTokens: 4 } });
	});

	test("LM Studio reads them from chat.end", async (t) => {
		serve(
			t,
			[
				["message.delta", { content: "The Tide Queen." }],
				["chat.end", { result: { stats: { input_tokens: 120, total_output_tokens: 4 } } }],
			]
				.map(([event, data]) => `event: ${event as string}\ndata: ${JSON.stringify(data)}\n\n`)
				.join(""),
		);
		const result = await lmstudioProvider.chatStream(endpoint("lmstudio", "http://lms.test"), messages, quiet);
		assert.deepEqual(result, { text: "The Tide Queen.", stats: { promptTokens: 120, responseTokens: 4 } });
	});
});

describe("OpenAI-style embeddings", () => {
	const cases: [string, LLMProvider, ProviderType, string, string, Record<string, string>][] = [
		["OpenAI-compatible", openaiCompatProvider, "openai-compat", "http://vllm.test", "http://vllm.test/v1/embeddings", {}],
		["OpenAI-compatible at /v1", openaiCompatProvider, "openai-compat", "http://vllm.test/v1/", "http://vllm.test/v1/embeddings", {}],
		[
			"OpenRouter",
			openrouterProvider,
			"openrouter",
			"https://openrouter.test/api/v1",
			"https://openrouter.test/api/v1/embeddings",
			{ "X-OpenRouter-Title": "Vaso" },
		],
		["LM Studio", lmstudioProvider, "lmstudio", "http://lms.test/", "http://lms.test/v1/embeddings", {}],
	];

	for (const [name, provider, providerType, url, embedUrl, extraHeaders] of cases) {
		test(name, async () => {
			const ep = {
				...endpoint(providerType, url, "embedding"),
				customParams: [
					{ key: "dimensions", value: "2" },
					{ key: "model", value: "overridden" },
				],
			};
			onRequest(() => ({
				json: {
					data: [
						{ index: 1, embedding: [0, 1] },
						{ index: 0, embedding: [1, 0] },
					],
				},
			}));
			assert.deepEqual(await provider.embedBatch(ep, ["red", "blue"]), [
				[1, 0],
				[0, 1],
			]);
			assert.deepEqual(requests, [
				{
					url: embedUrl,
					method: "POST",
					headers: { "Content-Type": "application/json", ...extraHeaders, Authorization: "Bearer test-key" },
					body: { dimensions: 2, model: "m", input: ["red", "blue"] },
				},
			]);

			onRequest(() => ({ json: { data: [{ index: 0, embedding: [1, 0] }] } }));
			await assert.rejects(provider.embedBatch(ep, ["red", "blue"]), /Invalid embedding response/);

			onRequest(() => ({ json: {} }));
			assert.deepEqual(await provider.embedBatch(ep, []), []);
			assert.equal(requests.length, 0);
		});
	}
});
