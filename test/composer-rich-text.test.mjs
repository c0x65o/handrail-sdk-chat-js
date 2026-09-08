import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  composerMarkdownToRichTextDocument,
  richTextDocumentToCanonicalMarkdown,
  sanitizeComposerMarkdownLink,
} from "../dist/ui/index.js";

const semanticFixtures = [
  {
    name: "paragraph and every inline mark",
    markdown: "__Bold__ and _italic_ and ~~removed~~ with [docs](https://example.test/docs) and `inline code`",
    canonical: "**Bold** and *italic* and ~~removed~~ with [docs](https://example.test/docs) and `inline code`",
  },
  {
    name: "ordinary paragraph newlines",
    markdown: "first line\r\nsecond line",
    canonical: "first line\nsecond line",
  },
  {
    name: "unordered list aliases",
    markdown: "+ first\n* second",
    canonical: "- first\n- second",
  },
  {
    name: "ordered list items and starting ordinals",
    markdown: "3) third\n4. fourth",
    canonical: "3. third\n4. fourth",
  },
  {
    name: "fenced code block and language",
    markdown: "~~~ts\nconst answer = 42;\n~~~",
    canonical: "```ts\nconst answer = 42;\n```",
  },
  {
    name: "mixed block controls",
    markdown: "A paragraph\n\n- bullet\n\n7. item\n\n```\ncode\n```",
    canonical: "A paragraph\n\n- bullet\n\n7. item\n\n```\ncode\n```",
  },
];

for (const fixture of semanticFixtures) {
  test(`semantically round trips ${fixture.name}`, () => {
    const document = composerMarkdownToRichTextDocument(fixture.markdown);
    const canonical = richTextDocumentToCanonicalMarkdown(document);

    assert.equal(canonical, fixture.canonical);
    assert.deepEqual(
      composerMarkdownToRichTextDocument(canonical),
      document,
    );
  });
}

test("returns a deeply immutable bounded document", () => {
  const document = composerMarkdownToRichTextDocument(
    "**bold**\n\n- item\n\n```ts\ncode\n```",
  );

  assert.equal(Object.isFrozen(document), true);
  assert.equal(Object.isFrozen(document.blocks), true);
  for (const block of document.blocks) {
    assert.equal(Object.isFrozen(block), true);
    if ("content" in block) {
      assert.equal(Object.isFrozen(block.content), true);
      for (const span of block.content) {
        assert.equal(Object.isFrozen(span), true);
        assert.equal(Object.isFrozen(span.marks), true);
        for (const mark of span.marks) assert.equal(Object.isFrozen(mark), true);
      }
    }
  }
});

test("keeps escaped and unmatched Markdown markers as editable literal text", () => {
  const escaped = String.raw`\*literal\* and \[not a link\] and \`not code\``;
  const escapedDocument = composerMarkdownToRichTextDocument(escaped);
  assert.equal(escapedDocument.blocks[0].content[0].text, "*literal* and [not a link] and `not code`");
  assert.deepEqual(escapedDocument.blocks[0].content[0].marks, []);
  assert.equal(richTextDocumentToCanonicalMarkdown(escapedDocument), escaped);

  const malformed = "before **open and [broken](https://example.test";
  const malformedDocument = composerMarkdownToRichTextDocument(malformed);
  assert.equal(malformedDocument.blocks[0].content[0].text, malformed);
  assert.deepEqual(malformedDocument.blocks[0].content[0].marks, []);
  assert.equal(
    richTextDocumentToCanonicalMarkdown(malformedDocument),
    String.raw`before \*\*open and \[broken\](https://example.test`,
  );

  const unclosedFence = "```ts\nstill editable";
  const fenceDocument = composerMarkdownToRichTextDocument(unclosedFence);
  assert.equal(fenceDocument.blocks[0].type, "paragraph");
  assert.equal(fenceDocument.blocks[0].content[0].text, unclosedFence);
  assert.equal(
    richTextDocumentToCanonicalMarkdown(fenceDocument),
    "\\`\\`\\`ts\nstill editable",
  );
});

test("keeps unsupported Markdown constructs as editable plain text", () => {
  const unsupported = "# heading\n> quote\n![alt](https://example.test/image.png)";
  const document = composerMarkdownToRichTextDocument(unsupported);

  assert.equal(document.blocks[0].content.map(({ text }) => text).join(""), unsupported);
  assert.deepEqual(document.blocks[0].content.flatMap(({ marks }) => marks), []);
  assert.equal(
    richTextDocumentToCanonicalMarkdown(document),
    "# heading\n> quote\n!\\[alt\\](https://example.test/image.png)",
  );
});

test("preserves mention token text through marked and unmarked round trips", () => {
  const markdown = "Hello @Display Name and **@Release Captain**";
  const document = composerMarkdownToRichTextDocument(markdown);
  assert.equal(
    document.blocks[0].content.map(({ text }) => text).join(""),
    "Hello @Display Name and @Release Captain",
  );
  assert.equal(richTextDocumentToCanonicalMarkdown(document), markdown);
});

test("keeps unsafe links as complete inert text and strips controls from safe destinations", () => {
  const unsafeDestinations = [
    "javascript:alert(1)",
    "data:text/html,payload",
    "java\u0000script:alert(1)",
  ];
  for (const destination of unsafeDestinations) {
    const markdown = `[label](${destination})`;
    const document = composerMarkdownToRichTextDocument(markdown);
    const span = document.blocks[0].content[0];
    assert.equal(span.text, markdown);
    assert.deepEqual(span.marks, []);
    assert.equal(
      composerMarkdownToRichTextDocument(richTextDocumentToCanonicalMarkdown(document))
        .blocks[0].content[0].text,
      markdown,
    );
  }

  const controlledSafeLink = composerMarkdownToRichTextDocument(
    "[mail](ma\u0000ilto:person@example.test)",
  );
  assert.deepEqual(controlledSafeLink.blocks[0].content[0].marks, [
    { type: "link", href: "mailto:person@example.test" },
  ]);
  assert.equal(
    richTextDocumentToCanonicalMarkdown(controlledSafeLink),
    "[mail](mailto:person@example.test)",
  );
  assert.equal(sanitizeComposerMarkdownLink("https://example.test\u007f/path"), "https://example.test/path");
  assert.equal(sanitizeComposerMarkdownLink("ftp://example.test/file"), undefined);
});

test("serializes equivalent mark input in one deterministic canonical order", () => {
  const document = {
    type: "document",
    blocks: [{
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "formatted",
          marks: [
            { type: "code" },
            { type: "italic" },
            { type: "bold" },
            { type: "bold" },
          ],
        },
        { type: "text", text: " literal * marker", marks: [] },
      ],
    }],
  };
  const canonical = "**_`formatted`_** literal \\* marker";

  assert.equal(richTextDocumentToCanonicalMarkdown(document), canonical);
  assert.equal(
    richTextDocumentToCanonicalMarkdown(composerMarkdownToRichTextDocument(canonical)),
    canonical,
  );
});

test("chooses a deterministic longer fence when code contains backtick runs", () => {
  const document = {
    type: "document",
    blocks: [{ type: "code-block", text: "before ``` after" }],
  };
  const canonical = "````\nbefore ``` after\n````";

  assert.equal(richTextDocumentToCanonicalMarkdown(document), canonical);
  assert.deepEqual(composerMarkdownToRichTextDocument(canonical), document);
});

test("has no runtime imports or client, server, transport, React, DOM, or testing boundary", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../src/ui/composer-rich-text.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/(?:import|export)\s+[^;]*?from\s+["']([^"']+)["']/g)]
    .map((match) => match[1]);

  assert.deepEqual(imports, []);
  assert.doesNotMatch(imports.join("\n"), /(?:react|dom|client|server|transport|testing|node:)/i);
});
