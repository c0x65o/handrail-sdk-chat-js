/**
 * Runtime-neutral rich-text model for the Markdown subset understood by the
 * default message timeline. The wire and draft formats remain Markdown; this
 * model is only an immutable editing boundary for composer renderers.
 */

export type ComposerRichTextMark =
  | { readonly type: "bold" }
  | { readonly type: "italic" }
  | { readonly type: "strikethrough" }
  | { readonly type: "code" }
  | { readonly type: "link"; readonly href: string };

export interface ComposerRichTextSpan {
  readonly type: "text";
  readonly text: string;
  readonly marks: readonly ComposerRichTextMark[];
}

export interface ComposerRichTextParagraph {
  readonly type: "paragraph";
  readonly content: readonly ComposerRichTextSpan[];
}

export interface ComposerRichTextUnorderedListItem {
  readonly type: "unordered-list-item";
  readonly content: readonly ComposerRichTextSpan[];
}

export interface ComposerRichTextOrderedListItem {
  readonly type: "ordered-list-item";
  readonly ordinal: number;
  readonly content: readonly ComposerRichTextSpan[];
}

export interface ComposerRichTextCodeBlock {
  readonly type: "code-block";
  readonly text: string;
  readonly language?: string;
}

export type ComposerRichTextBlock =
  | ComposerRichTextParagraph
  | ComposerRichTextUnorderedListItem
  | ComposerRichTextOrderedListItem
  | ComposerRichTextCodeBlock;

export interface ComposerRichTextDocument {
  readonly type: "document";
  readonly blocks: readonly ComposerRichTextBlock[];
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const LIST_LINE = /^ {0,3}(?:([-+*])|(\d+)[.)])[\t ]+(.*)$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/;

const BOLD_MARK = Object.freeze({ type: "bold" } as const);
const ITALIC_MARK = Object.freeze({ type: "italic" } as const);
const STRIKETHROUGH_MARK = Object.freeze({ type: "strikethrough" } as const);
const CODE_MARK = Object.freeze({ type: "code" } as const);

/**
 * Returns the inert, control-character-free destination accepted by the
 * timeline's link policy, or undefined when the destination must stay text.
 */
export const sanitizeComposerMarkdownLink = (href: string): string | undefined => {
  const sanitized = href.replace(CONTROL_CHARACTERS, "").trim();
  if (sanitized.length === 0) return undefined;
  try {
    const parsed = new URL(sanitized, "https://handrail.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:"
      ? sanitized
      : undefined;
  } catch {
    return undefined;
  }
};

const sameMarks = (
  left: readonly ComposerRichTextMark[],
  right: readonly ComposerRichTextMark[],
): boolean => left.length === right.length && left.every((mark, index) => {
  const candidate = right[index];
  return candidate !== undefined && mark.type === candidate.type &&
    (mark.type !== "link" || (candidate.type === "link" && mark.href === candidate.href));
});

const appendSpan = (
  spans: ComposerRichTextSpan[],
  text: string,
  marks: readonly ComposerRichTextMark[] = [],
): void => {
  if (text.length === 0) return;
  const previous = spans.at(-1);
  if (previous !== undefined && sameMarks(previous.marks, marks)) {
    spans[spans.length - 1] = Object.freeze({
      type: "text",
      text: previous.text + text,
      marks: previous.marks,
    });
    return;
  }
  spans.push(Object.freeze({
    type: "text",
    text,
    marks: Object.freeze([...marks]),
  }));
};

const addOuterMark = (
  spans: readonly ComposerRichTextSpan[],
  mark: ComposerRichTextMark,
): readonly ComposerRichTextSpan[] => {
  const marked: ComposerRichTextSpan[] = [];
  for (const span of spans) appendSpan(marked, span.text, [mark, ...span.marks]);
  return Object.freeze(marked);
};

const parseInline = (source: string): readonly ComposerRichTextSpan[] => {
  const spans: ComposerRichTextSpan[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "\\" && index + 1 < source.length) {
      appendSpan(spans, source[index + 1] ?? "");
      index += 2;
      continue;
    }

    if (character === "`") {
      const closing = source.indexOf("`", index + 1);
      if (closing > index + 1) {
        appendSpan(spans, source.slice(index + 1, closing), [CODE_MARK]);
        index = closing + 1;
        continue;
      }
    }

    if (character === "!" && source[index + 1] === "[") {
      const labelEnd = source.indexOf("](", index + 2);
      const destinationEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 2 && destinationEnd > labelEnd + 2) {
        appendSpan(spans, source.slice(index, destinationEnd + 1));
        index = destinationEnd + 1;
        continue;
      }
    }

    if (character === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      const destinationEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && destinationEnd > labelEnd + 2) {
        const destination = source.slice(labelEnd + 2, destinationEnd);
        const href = sanitizeComposerMarkdownLink(destination);
        const entireLink = source.slice(index, destinationEnd + 1);
        if (href === undefined) {
          appendSpan(spans, entireLink);
        } else {
          const linkMark = Object.freeze({ type: "link", href } as const);
          const label = parseInline(source.slice(index + 1, labelEnd));
          for (const span of addOuterMark(label, linkMark)) {
            appendSpan(spans, span.text, span.marks);
          }
        }
        index = destinationEnd + 1;
        continue;
      }
    }

    const marker = source.startsWith("**", index)
      ? "**"
      : source.startsWith("__", index)
        ? "__"
        : source.startsWith("~~", index)
          ? "~~"
          : character === "*" || character === "_"
            ? character
            : undefined;
    if (marker !== undefined) {
      const closing = source.indexOf(marker, index + marker.length);
      if (closing > index + marker.length) {
        const mark = marker === "~~"
          ? STRIKETHROUGH_MARK
          : marker.length === 2
            ? BOLD_MARK
            : ITALIC_MARK;
        const marked = addOuterMark(
          parseInline(source.slice(index + marker.length, closing)),
          mark,
        );
        for (const span of marked) appendSpan(spans, span.text, span.marks);
        index = closing + marker.length;
        continue;
      }
    }

    appendSpan(spans, character);
    index += 1;
  }

  return Object.freeze(spans);
};

interface ParsedFence {
  readonly character: string;
  readonly length: number;
  readonly language?: string;
}

const parseFence = (line: string): ParsedFence | undefined => {
  const match = line.match(FENCE_LINE);
  const marker = match?.[1];
  if (marker === undefined) return undefined;
  const language = (match?.[2] ?? "").trim();
  return Object.freeze({
    character: marker[0] ?? "`",
    length: marker.length,
    ...(language.length > 0 ? { language } : {}),
  });
};

const closesFence = (line: string, fence: ParsedFence): boolean => {
  const marker = line.trim();
  return marker.length >= fence.length &&
    [...marker].every((character) => character === fence.character);
};

const closingFenceIndex = (
  lines: readonly string[],
  openingIndex: number,
  fence: ParsedFence,
): number => {
  for (let index = openingIndex + 1; index < lines.length; index += 1) {
    if (closesFence(lines[index] ?? "", fence)) return index;
  }
  return -1;
};

const paragraph = (source: string): ComposerRichTextParagraph => Object.freeze({
  type: "paragraph",
  content: parseInline(source),
});

/** Converts stored composer Markdown into a deeply immutable editing document. */
export const composerMarkdownToRichTextDocument = (source: string): ComposerRichTextDocument => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ComposerRichTextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if ((lines[index] ?? "").trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = parseFence(lines[index] ?? "");
    if (fence !== undefined) {
      const closingIndex = closingFenceIndex(lines, index, fence);
      if (closingIndex !== -1) {
        blocks.push(Object.freeze({
          type: "code-block",
          text: lines.slice(index + 1, closingIndex).join("\n"),
          ...(fence.language === undefined ? {} : { language: fence.language }),
        }));
        index = closingIndex + 1;
        continue;
      }

      // An unclosed fence is editable literal text, not an activated code node.
      const fallbackLines = [lines[index] ?? ""];
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim().length > 0) {
        fallbackLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push(paragraph(fallbackLines.join("\n")));
      continue;
    }

    const listMatch = (lines[index] ?? "").match(LIST_LINE);
    if (listMatch !== null) {
      const ordered = listMatch[2] !== undefined;
      while (index < lines.length) {
        const itemMatch = (lines[index] ?? "").match(LIST_LINE);
        if (itemMatch === null || (itemMatch[2] !== undefined) !== ordered) break;
        const content = parseInline(itemMatch[3] ?? "");
        if (ordered) {
          blocks.push(Object.freeze({
            type: "ordered-list-item",
            ordinal: Number(itemMatch[2]),
            content,
          }));
        } else {
          blocks.push(Object.freeze({ type: "unordered-list-item", content }));
        }
        index += 1;
      }
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim().length > 0) {
      const candidate = lines[index] ?? "";
      if (candidate.match(LIST_LINE) !== null || parseFence(candidate) !== undefined) break;
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push(paragraph(paragraphLines.join("\n")));
  }

  return Object.freeze({ type: "document", blocks: Object.freeze(blocks) });
};

const MARK_ORDER: Readonly<Record<ComposerRichTextMark["type"], number>> = Object.freeze({
  bold: 0,
  italic: 1,
  strikethrough: 2,
  link: 3,
  code: 4,
});

const normalizeMarks = (
  marks: readonly ComposerRichTextMark[],
  text: string,
): readonly ComposerRichTextMark[] => {
  const byType = new Map<ComposerRichTextMark["type"], ComposerRichTextMark>();
  for (const mark of marks) {
    if (byType.has(mark.type)) continue;
    if (mark.type === "link") {
      const href = sanitizeComposerMarkdownLink(mark.href);
      if (href !== undefined) byType.set("link", Object.freeze({ type: "link", href }));
    } else if (mark.type !== "code" || !text.includes("`")) {
      byType.set(mark.type, mark);
    }
  }
  return Object.freeze([...byType.values()].sort(
    (left, right) => MARK_ORDER[left.type] - MARK_ORDER[right.type],
  ));
};

const escapeInlineText = (text: string): string => text.replace(/[\\`*_\[\]~]/g, "\\$&");

const serializeSpan = (span: ComposerRichTextSpan, marks: readonly ComposerRichTextMark[]): string => {
  let value = marks.some(({ type }) => type === "code") ? span.text : escapeInlineText(span.text);
  const hasBold = marks.some(({ type }) => type === "bold");
  for (let index = marks.length - 1; index >= 0; index -= 1) {
    const mark = marks[index];
    if (mark === undefined) continue;
    switch (mark.type) {
      case "bold":
        value = `**${value}**`;
        break;
      case "italic":
        // Underscores keep nested bold+italic delimiters unambiguous for the
        // timeline's deliberately small, first-closing-marker inline parser.
        value = hasBold ? `_${value}_` : `*${value}*`;
        break;
      case "strikethrough":
        value = `~~${value}~~`;
        break;
      case "code":
        value = `\`${value}\``;
        break;
      case "link":
        value = `[${value}](${mark.href.replace(/\)/g, "%29")})`;
        break;
    }
  }
  return value;
};

const serializeInline = (content: readonly ComposerRichTextSpan[]): string => {
  const normalized: Array<{ readonly text: string; readonly marks: readonly ComposerRichTextMark[] }> = [];
  for (const span of content) {
    if (span.text.length === 0) continue;
    const marks = normalizeMarks(span.marks, span.text);
    const previous = normalized.at(-1);
    if (previous !== undefined && sameMarks(previous.marks, marks)) {
      normalized[normalized.length - 1] = Object.freeze({
        text: previous.text + span.text,
        marks,
      });
    } else {
      normalized.push(Object.freeze({ text: span.text, marks }));
    }
  }
  return normalized.map((span) => serializeSpan(
    Object.freeze({ type: "text", text: span.text, marks: span.marks }),
    span.marks,
  )).join("");
};

const keepParagraphLinesInert = (markdown: string): string => markdown.split("\n").map((line) => {
  if (/^ {0,3}[-+][\t ]/.test(line)) return line.replace(/([-+])/, "\\$1");
  if (/^ {0,3}\d+[.)][\t ]/.test(line)) return line.replace(/([.)])/, "\\$1");
  return line;
}).join("\n");

const codeFence = (text: string): string => {
  let length = 3;
  for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  return "`".repeat(length);
};

const serializeBlock = (block: ComposerRichTextBlock): string => {
  switch (block.type) {
    case "paragraph":
      return keepParagraphLinesInert(serializeInline(block.content));
    case "unordered-list-item":
      return `- ${serializeInline(block.content)}`;
    case "ordered-list-item": {
      const ordinal = Number.isSafeInteger(block.ordinal) && block.ordinal >= 0
        ? block.ordinal
        : 1;
      return `${ordinal}. ${serializeInline(block.content)}`;
    }
    case "code-block": {
      const fence = codeFence(block.text);
      const language = block.language?.replace(/[\r\n]+/g, " ").trim() ?? "";
      return `${fence}${language}\n${block.text}\n${fence}`;
    }
  }
};

const sameListKind = (left: ComposerRichTextBlock, right: ComposerRichTextBlock): boolean =>
  (left.type === "unordered-list-item" && right.type === "unordered-list-item") ||
  (left.type === "ordered-list-item" && right.type === "ordered-list-item");

/** Serializes an editing document to deterministic Markdown for storage/wire use. */
export const richTextDocumentToCanonicalMarkdown = (document: ComposerRichTextDocument): string => {
  let markdown = "";
  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index];
    if (block === undefined) continue;
    if (index > 0) {
      const previous = document.blocks[index - 1];
      markdown += previous !== undefined && sameListKind(previous, block) ? "\n" : "\n\n";
    }
    markdown += serializeBlock(block);
  }
  return markdown;
};
