import assert from "node:assert/strict";
import { test } from "node:test";
import { usesContextSize } from "../src/settings/endpoint-modal";

test("the context window is offered only where it reaches the server", () => {
	assert.equal(usesContextSize({ type: "inference", providerType: "ollama" }), true);
	assert.equal(usesContextSize({ type: "embedding", providerType: "ollama" }), true);
	assert.equal(usesContextSize({ type: "inference", providerType: "lmstudio" }), true);
	assert.equal(usesContextSize({ type: "embedding", providerType: "lmstudio" }), false);
	assert.equal(usesContextSize({ type: "inference", providerType: "openrouter" }), false);
	assert.equal(usesContextSize({ type: "embedding", providerType: "openai-compat" }), false);
});
