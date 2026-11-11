import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { positiveInt, redactUrl } from "../src/providers/http";

describe("redactUrl", () => {
	test("drops the user name and password", () => {
		assert.equal(redactUrl("http://user:secret@example.com:11434/v1"), "http://example.com:11434/v1");
		assert.equal(redactUrl("https://token@example.com/api"), "https://example.com/api");
	});

	test("leaves a URL without credentials as it was", () => {
		assert.equal(redactUrl("http://localhost:11434"), "http://localhost:11434");
		assert.equal(redactUrl("https://example.com/search?q=a@b"), "https://example.com/search?q=a@b");
	});

	test("strips credentials from text that is not a full URL", () => {
		assert.equal(redactUrl("user:secret@example.com:1234/v1"), "example.com:1234/v1");
		assert.equal(redactUrl("//user:secret@example.com/v1"), "//example.com/v1");
		assert.equal(redactUrl("example.com/path?mail=a@b"), "example.com/path?mail=a@b");
	});
});

test("positiveInt accepts only positive safe integers", () => {
	assert.equal(positiveInt(4096), 4096);
	for (const v of [0, -1, 1.5, Infinity, NaN, 2 ** 53, "4096", null, undefined]) {
		assert.equal(positiveInt(v), undefined, String(v));
	}
});
