import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { frontmatterLength, inertMarkdown, splitParagraphs, stripFrontmatter } from "../src/text";

const ZWSP = "\u200B";

describe("frontmatter", () => {
	test("a leading block is stripped", () => {
		assert.equal(stripFrontmatter("---\ntitle: Dragon\n---\nThe dragon sleeps."), "The dragon sleeps.");
		assert.equal(stripFrontmatter("---\r\ntitle: Dragon\r\n---\r\nThe dragon sleeps."), "The dragon sleeps.");
	});

	test("an empty block ends at its second line, not at a later rule", () => {
		const note = "---\n---\nIntro\n\n---\n\nAfter the rule";
		assert.equal(frontmatterLength(note), 8);
		assert.equal(stripFrontmatter(note), "Intro\n\n---\n\nAfter the rule");
	});

	test("a note without frontmatter keeps its rules", () => {
		const note = "Intro\n\n---\n\nAfter the rule";
		assert.equal(frontmatterLength(note), 0);
		assert.equal(stripFrontmatter(note), note);
	});
});

describe("splitParagraphs", () => {
	test("paragraphs keep their offsets in the text", () => {
		const text = "One\n\nTwo\r\n\r\nThree";
		const paragraphs = splitParagraphs(text);
		assert.deepEqual(paragraphs, [
			{ start: 0, end: 3 },
			{ start: 5, end: 8 },
			{ start: 12, end: 17 },
		]);
		assert.deepEqual(
			paragraphs.map((p) => text.slice(p.start, p.end)),
			["One", "Two", "Three"],
		);
	});

	test("blank and whitespace-only parts are no paragraphs", () => {
		assert.deepEqual(splitParagraphs("\n\n  \n\nOne\n \t \n\n"), [{ start: 6, end: 9 }]);
		assert.deepEqual(splitParagraphs(" \n\t"), []);
	});
});

describe("inertMarkdown", () => {
	test("fence info strings and the first code line get a zero-width space", () => {
		assert.equal(
			inertMarkdown("```dataviewjs\ndv.span(1)\n```"),
			"```" + ZWSP + "dataviewjs\n" + ZWSP + "dv.span(1)\n```",
		);
	});

	test("images, embeds and HTML tags are broken up", () => {
		assert.equal(inertMarkdown("![x](https://example.com/a.png)"), "!" + ZWSP + "[x](https://example.com/a.png)");
		assert.equal(inertMarkdown("![[Map.png]]"), "!" + ZWSP + "[[Map.png]]");
		assert.equal(inertMarkdown("<img src=x onerror=alert(1)>"), "<" + ZWSP + "img src=x onerror=alert(1)>");
	});

	test("inline query prefixes don't match", () => {
		assert.equal(inertMarkdown("`= this.file.name`"), "`" + ZWSP + "= this.file.name`" + ZWSP);
		assert.equal(inertMarkdown("= [[Dragon]].age"), ZWSP + "= [[Dragon]].age");
		assert.equal(inertMarkdown("$= dv.current()"), ZWSP + "$= dv.current()");
	});

	test("autolinks, setext headings and link destinations keep working", () => {
		assert.equal(inertMarkdown("<https://example.com>"), "<https://example.com>");
		assert.equal(inertMarkdown("Title\n==="), "Title\n===");
		assert.equal(inertMarkdown("[Source](<Some Note.md>)"), "[Source](Some%20Note.md)");
	});
});
