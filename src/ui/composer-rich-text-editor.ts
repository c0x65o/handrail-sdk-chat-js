import type {
  ComposerRichTextBlock,
  ComposerRichTextDocument,
  ComposerRichTextMark,
  ComposerRichTextSpan,
} from "./composer-rich-text.js";
import {
  richTextDocumentToCanonicalMarkdown,
  sanitizeComposerMarkdownLink,
} from "./composer-rich-text.js";

export type ComposerRichTextCommand =
  | "bold"
  | "italic"
  | "strikethrough"
  | "link"
  | "ordered-list"
  | "bulleted-list"
  | "inline-code"
  | "code-block";

export interface ComposerVisualSelection {
  readonly start: number;
  readonly end: number;
}

const CARET_BOUNDARY_ATTRIBUTE = "data-composer-caret-boundary";
const CARET_BOUNDARY_SENTINEL = "\u200B";

const textSpan = (
  text: string,
  marks: readonly ComposerRichTextMark[] = [],
): ComposerRichTextSpan => ({ type: "text", text, marks });

const paragraph = (
  content: readonly ComposerRichTextSpan[] = [],
): ComposerRichTextBlock => ({ type: "paragraph", content });

export const plainTextToComposerRichTextDocument = (
  text: string,
): ComposerRichTextDocument => ({
  type: "document",
  blocks: text.length === 0 ? [] : [paragraph([textSpan(text)])],
});

const blockText = (block: ComposerRichTextBlock): string => block.type === "code-block"
  ? block.text
  : block.content.map((span) => span.text).join("");

export const composerRichTextDocumentPlainText = (
  document: ComposerRichTextDocument,
): string => document.blocks.map(blockText).join("\n");

export const composerRichTextDocumentHasFormatting = (
  document: ComposerRichTextDocument,
): boolean => document.blocks.some((block) =>
  block.type !== "paragraph" || block.content.some((span) => span.marks.length > 0));

export const supportsVisualComposerEditing = (document: Document): boolean => {
  const editor = document.createElement("div");
  const view = document.defaultView;
  return "contentEditable" in editor &&
    typeof document.createRange === "function" &&
    typeof view?.getSelection === "function";
};

const appendText = (parent: HTMLElement, text: string): void => {
  const document = parent.ownerDocument;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (index > 0) parent.append(document.createElement("br"));
    if (line.length > 0) parent.append(document.createTextNode(line));
  });
};

const markElement = (
  document: Document,
  mark: ComposerRichTextMark,
): HTMLElement | undefined => {
  switch (mark.type) {
    case "bold": return document.createElement("strong");
    case "italic": return document.createElement("em");
    case "strikethrough": return document.createElement("s");
    case "code": return document.createElement("code");
    case "link": {
      const href = sanitizeComposerMarkdownLink(mark.href);
      if (href === undefined) return undefined;
      const anchor = document.createElement("a");
      anchor.setAttribute("href", href);
      anchor.setAttribute("rel", "noopener noreferrer");
      return anchor;
    }
  }
};

const appendRichContent = (
  parent: HTMLElement,
  content: readonly ComposerRichTextSpan[],
): void => {
  const document = parent.ownerDocument;
  for (const span of content) {
    let container = document.createElement("span");
    appendText(container, span.text);
    for (let index = span.marks.length - 1; index >= 0; index -= 1) {
      const mark = span.marks[index];
      if (mark === undefined) continue;
      const wrapper = markElement(document, mark);
      if (wrapper === undefined) continue;
      wrapper.append(container);
      container = wrapper;
    }
    parent.append(container);
  }
  if (!parent.hasChildNodes()) parent.append(document.createElement("br"));
};

export const renderComposerRichTextDocument = (
  editor: HTMLElement,
  richText: ComposerRichTextDocument,
): void => {
  const document = editor.ownerDocument;
  const fragment = document.createDocumentFragment();
  const blocks = richText.blocks.length === 0 ? [paragraph()] : richText.blocks;
  let activeList: HTMLOListElement | HTMLUListElement | undefined;
  let activeListType: "ordered-list-item" | "unordered-list-item" | undefined;

  for (const block of blocks) {
    if (block.type === "ordered-list-item" || block.type === "unordered-list-item") {
      if (activeList === undefined || activeListType !== block.type) {
        activeList = document.createElement(block.type === "ordered-list-item" ? "ol" : "ul");
        activeListType = block.type;
        fragment.append(activeList);
      }
      const item = document.createElement("li");
      item.dataset.composerBlock = block.type;
      if (block.type === "ordered-list-item") item.value = block.ordinal;
      if (block.type === "ordered-list-item" && activeList.childElementCount === 0) {
        (activeList as HTMLOListElement).start = block.ordinal;
      }
      appendRichContent(item, block.content);
      activeList.append(item);
      continue;
    }

    activeList = undefined;
    activeListType = undefined;
    if (block.type === "code-block") {
      const pre = document.createElement("pre");
      pre.dataset.composerBlock = "code-block";
      if (block.language !== undefined) pre.dataset.composerLanguage = block.language;
      const code = document.createElement("code");
      code.textContent = block.text;
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    const line = document.createElement("div");
    line.dataset.composerBlock = "paragraph";
    appendRichContent(line, block.content);
    fragment.append(line);
  }
  editor.replaceChildren(fragment);
};

const sameMark = (left: ComposerRichTextMark, right: ComposerRichTextMark): boolean =>
  left.type === right.type &&
  (left.type !== "link" || (right.type === "link" && left.href === right.href));

const appendExtractedSpan = (
  spans: ComposerRichTextSpan[],
  text: string,
  marks: readonly ComposerRichTextMark[],
): void => {
  if (text.length === 0) return;
  const previous = spans.at(-1);
  if (previous !== undefined && previous.marks.length === marks.length &&
    previous.marks.every((mark, index) => {
      const candidate = marks[index];
      return candidate !== undefined && sameMark(mark, candidate);
    })) {
    spans[spans.length - 1] = textSpan(previous.text + text, previous.marks);
    return;
  }
  spans.push(textSpan(text, [...marks]));
};

const marksForElement = (
  element: Element,
  inherited: readonly ComposerRichTextMark[],
): readonly ComposerRichTextMark[] => {
  const marks = [...inherited];
  const tag = element.tagName.toLowerCase();
  const add = (mark: ComposerRichTextMark): void => {
    const index = marks.findIndex((candidate) => candidate.type === mark.type);
    if (index >= 0) marks.splice(index, 1);
    marks.push(mark);
  };
  if (tag === "strong" || tag === "b") add({ type: "bold" });
  else if (tag === "em" || tag === "i") add({ type: "italic" });
  else if (tag === "s" || tag === "strike" || tag === "del") {
    add({ type: "strikethrough" });
  } else if (tag === "code") add({ type: "code" });
  else if (tag === "a") {
    const href = sanitizeComposerMarkdownLink(element.getAttribute("href") ?? "");
    if (href !== undefined) add({ type: "link", href });
  }
  return marks;
};

const extractInline = (
  node: Node,
  spans: ComposerRichTextSpan[],
  inherited: readonly ComposerRichTextMark[] = [],
): void => {
  if (node.nodeType === 3) {
    const text = Boolean(node.parentElement?.closest(`[${CARET_BOUNDARY_ATTRIBUTE}]`))
      ? (node.nodeValue ?? "").replaceAll(CARET_BOUNDARY_SENTINEL, "")
      : node.nodeValue ?? "";
    appendExtractedSpan(spans, text, inherited);
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  if (element.tagName.toLowerCase() === "br") {
    appendExtractedSpan(spans, "\n", inherited);
    return;
  }
  const marks = marksForElement(element, inherited);
  for (const child of element.childNodes) extractInline(child, spans, marks);
};

const plainDomText = (node: Node): string => {
  if (node.nodeType === 3) {
    return Boolean(node.parentElement?.closest(`[${CARET_BOUNDARY_ATTRIBUTE}]`))
      ? (node.nodeValue ?? "").replaceAll(CARET_BOUNDARY_SENTINEL, "")
      : node.nodeValue ?? "";
  }
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.tagName.toLowerCase() === "br") return "\n";
  return [...element.childNodes].map(plainDomText).join("");
};

const contentFromNode = (node: Node): readonly ComposerRichTextSpan[] => {
  const spans: ComposerRichTextSpan[] = [];
  extractInline(node, spans);
  if (spans.length === 1 && spans[0]?.text === "\n" &&
    (node as Element).childNodes.length === 1) return [];
  return spans;
};

export const composerRichTextDocumentFromEditor = (
  editor: HTMLElement,
): ComposerRichTextDocument => {
  const blocks: ComposerRichTextBlock[] = [];
  const loose: Node[] = [];
  const flushLoose = (): void => {
    if (loose.length === 0) return;
    const spans: ComposerRichTextSpan[] = [];
    loose.forEach((node) => extractInline(node, spans));
    blocks.push(paragraph(spans));
    loose.length = 0;
  };

  for (const child of editor.childNodes) {
    if (child.nodeType !== 1) {
      loose.push(child);
      continue;
    }
    const element = child as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "ol" || tag === "ul") {
      flushLoose();
      let ordinal = Number.parseInt(element.getAttribute("start") ?? "1", 10);
      if (!Number.isFinite(ordinal)) ordinal = 1;
      for (const item of element.children) {
        if (item.tagName.toLowerCase() !== "li") continue;
        const content = contentFromNode(item);
        if (tag === "ol") {
          const itemOrdinal = Number.parseInt(item.getAttribute("value") ?? `${ordinal}`, 10);
          blocks.push({
            type: "ordered-list-item",
            ordinal: Number.isFinite(itemOrdinal) ? itemOrdinal : ordinal,
            content,
          });
          ordinal = Number.isFinite(itemOrdinal) ? itemOrdinal + 1 : ordinal + 1;
        } else {
          blocks.push({ type: "unordered-list-item", content });
        }
      }
      continue;
    }
    if (tag === "pre") {
      flushLoose();
      const language = element.dataset.composerLanguage;
      blocks.push({
        type: "code-block",
        text: plainDomText(element),
        ...(language === undefined ? {} : { language }),
      });
      continue;
    }
    if (tag === "div" || tag === "p" || element.dataset.composerBlock !== undefined) {
      flushLoose();
      blocks.push(paragraph(contentFromNode(element)));
      continue;
    }
    loose.push(child);
  }
  flushLoose();
  return { type: "document", blocks };
};

const nodeLength = (node: Node): number => {
  if (node.nodeType === 3) {
    return Boolean(node.parentElement?.closest(`[${CARET_BOUNDARY_ATTRIBUTE}]`))
      ? (node.nodeValue ?? "").replaceAll(CARET_BOUNDARY_SENTINEL, "").length
      : (node.nodeValue ?? "").length;
  }
  if (node.nodeType !== 1) return 0;
  if ((node as Element).tagName.toLowerCase() === "br") return 1;
  return [...node.childNodes].reduce((length, child) => length + nodeLength(child), 0);
};

const isWithin = (root: Node, target: Node): boolean => {
  for (let current: Node | null = target; current !== null; current = current.parentNode) {
    if (current === root) return true;
  }
  return false;
};

export const composerRichTextCommandIsActiveAtSelection = (
  editor: HTMLElement,
  command: ComposerRichTextCommand,
): boolean => {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (selection === undefined || selection === null || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !isWithin(editor, range.startContainer)) return false;
  for (
    let element = range.startContainer.nodeType === 1
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    element !== null && element !== editor;
    element = element.parentElement
  ) {
    const tag = element.tagName.toLowerCase();
    if (command === "bold" && (tag === "strong" || tag === "b")) return true;
    if (command === "italic" && (tag === "em" || tag === "i")) return true;
    if (command === "strikethrough" && ["s", "strike", "del"].includes(tag)) return true;
    if (command === "inline-code" && tag === "code" && element.parentElement?.tagName !== "PRE") {
      return true;
    }
    if (command === "link" && tag === "a") return true;
  }
  return false;
};

const offsetWithin = (root: Node, target: Node, offset: number): number | undefined => {
  if (root === target) {
    if (root.nodeType === 3) return Math.max(0, Math.min(offset, nodeLength(root)));
    let length = 0;
    const children = [...root.childNodes];
    for (let index = 0; index < Math.min(offset, children.length); index += 1) {
      const child = children[index];
      if (child !== undefined) length += nodeLength(child);
    }
    return length;
  }
  let length = 0;
  for (const child of root.childNodes) {
    if (isWithin(child, target)) {
      const nested = offsetWithin(child, target, offset);
      return nested === undefined ? undefined : length + nested;
    }
    length += nodeLength(child);
  }
  return undefined;
};

const logicalBlocks = (editor: HTMLElement): readonly Node[] => {
  const blocks: Node[] = [];
  for (const child of editor.childNodes) {
    if (child.nodeType === 1 && ["ol", "ul"].includes((child as Element).tagName.toLowerCase())) {
      blocks.push(...[...(child as Element).children].filter((item) =>
        item.tagName.toLowerCase() === "li"));
    } else {
      blocks.push(child);
    }
  }
  return blocks;
};

const pointToVisualOffset = (
  editor: HTMLElement,
  target: Node,
  offset: number,
): number | undefined => {
  if (!isWithin(editor, target)) return undefined;
  const blocks = logicalBlocks(editor);
  let position = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (index > 0) position += 1;
    if (isWithin(block, target)) {
      const local = offsetWithin(block, target, offset);
      return local === undefined ? undefined : position + local;
    }
    position += nodeLength(block);
  }
  if (target === editor) {
    const childCount = Math.max(0, Math.min(offset, editor.childNodes.length));
    const prefix = [...editor.childNodes].slice(0, childCount);
    return composerRichTextDocumentPlainText(composerRichTextDocumentFromNodes(prefix)).length;
  }
  return position;
};

const composerRichTextDocumentFromNodes = (nodes: readonly Node[]): ComposerRichTextDocument => {
  const editor = nodes[0]?.ownerDocument?.createElement("div");
  if (editor === undefined) return { type: "document", blocks: [] };
  for (const node of nodes) editor.append(node.cloneNode(true));
  return composerRichTextDocumentFromEditor(editor);
};

export const readComposerRichTextSelection = (
  editor: HTMLElement,
): ComposerVisualSelection | undefined => {
  const selection = editor.ownerDocument.defaultView?.getSelection();
  if (selection === undefined || selection === null || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const start = pointToVisualOffset(editor, range.startContainer, range.startOffset);
  const end = pointToVisualOffset(editor, range.endContainer, range.endOffset);
  if (start === undefined || end === undefined) return undefined;
  return { start: Math.min(start, end), end: Math.max(start, end) };
};

interface DomPoint {
  readonly node: Node;
  readonly offset: number;
}

const pointWithin = (root: Node, offset: number): DomPoint => {
  const bounded = Math.max(0, Math.min(offset, nodeLength(root)));
  if (root.nodeType === 3) return { node: root, offset: bounded };
  let position = 0;
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes[index];
    if (child === undefined) continue;
    const length = nodeLength(child);
    if (bounded <= position + length) {
      if (child.nodeType === 1 && (child as Element).tagName.toLowerCase() === "br") {
        return { node: root, offset: bounded === position ? index : index + 1 };
      }
      return pointWithin(child, bounded - position);
    }
    position += length;
  }
  return { node: root, offset: root.childNodes.length };
};

const visualOffsetToPoint = (editor: HTMLElement, offset: number): DomPoint => {
  const blocks = logicalBlocks(editor);
  const total = composerRichTextDocumentPlainText(composerRichTextDocumentFromEditor(editor)).length;
  const bounded = Math.max(0, Math.min(offset, total));
  let position = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (index > 0) {
      if (bounded === position) return pointWithin(block, 0);
      position += 1;
    }
    const length = nodeLength(block);
    if (bounded <= position + length) return pointWithin(block, bounded - position);
    position += length;
  }
  return { node: editor, offset: editor.childNodes.length };
};

export const setComposerRichTextSelection = (
  editor: HTMLElement,
  selection: ComposerVisualSelection,
): void => {
  const document = editor.ownerDocument;
  const browserSelection = document.defaultView?.getSelection();
  if (browserSelection === undefined || browserSelection === null) return;
  const start = visualOffsetToPoint(editor, selection.start);
  const end = visualOffsetToPoint(editor, selection.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  browserSelection.removeAllRanges();
  browserSelection.addRange(range);
};

const insertIntoContent = (
  content: readonly ComposerRichTextSpan[],
  offset: number,
  inserted: ComposerRichTextSpan,
): readonly ComposerRichTextSpan[] => {
  const next: ComposerRichTextSpan[] = [];
  let position = 0;
  let complete = false;
  for (const span of content) {
    const end = position + span.text.length;
    if (!complete && offset <= end) {
      const local = Math.max(0, offset - position);
      if (local > 0) next.push(textSpan(span.text.slice(0, local), span.marks));
      next.push(inserted);
      if (local < span.text.length) next.push(textSpan(span.text.slice(local), span.marks));
      complete = true;
    } else next.push(span);
    position = end;
  }
  if (!complete) next.push(inserted);
  return next;
};

const insertAtVisualOffset = (
  document: ComposerRichTextDocument,
  offset: number,
  inserted: ComposerRichTextSpan,
): ComposerRichTextDocument => {
  const blocks = document.blocks.length === 0 ? [paragraph()] : [...document.blocks];
  let position = 0;
  let targetIndex = blocks.length - 1;
  for (let index = 0; index < blocks.length; index += 1) {
    const length = blockText(blocks[index]!).length;
    if (offset <= position + length) {
      targetIndex = index;
      break;
    }
    position += length + 1;
  }
  const target = blocks[targetIndex]!;
  const local = Math.max(0, Math.min(offset - position, blockText(target).length));
  blocks[targetIndex] = target.type === "code-block"
    ? { ...target, text: `${target.text.slice(0, local)}${inserted.text}${target.text.slice(local)}` }
    : { ...target, content: insertIntoContent(target.content, local, inserted) };
  return { type: "document", blocks };
};

const SENTINEL = "\uE000";

export const renderComposerRichTextDocumentWithCaretBoundary = (
  editor: HTMLElement,
  richText: ComposerRichTextDocument,
  offset: number,
  marks: readonly ComposerRichTextMark[],
): void => {
  const withBoundary = insertAtVisualOffset(
    richText,
    offset,
    textSpan(SENTINEL, marks),
  );
  renderComposerRichTextDocument(editor, withBoundary);

  const document = editor.ownerDocument;
  const walker = document.createTreeWalker(editor, 4);
  let boundaryText: Text | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.nodeValue ?? "").includes(SENTINEL)) {
      boundaryText = node as Text;
      break;
    }
  }
  if (boundaryText === undefined) {
    setComposerRichTextSelection(editor, { start: offset, end: offset });
    return;
  }
  boundaryText.nodeValue = (boundaryText.nodeValue ?? "").replace(SENTINEL, CARET_BOUNDARY_SENTINEL);
  boundaryText.parentElement?.setAttribute(CARET_BOUNDARY_ATTRIBUTE, "true");
  const selection = document.defaultView?.getSelection();
  if (selection === undefined || selection === null) return;
  const range = document.createRange();
  // Chromium derives the typing style at an inline boundary from the character
  // immediately before the caret. Put the caret after the unformatted sentinel
  // so native input remains outside the mark to its left.
  range.setStart(boundaryText, boundaryText.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
};

export const removeComposerRichTextCaretBoundary = (editor: HTMLElement): void => {
  for (const boundary of editor.querySelectorAll(`[${CARET_BOUNDARY_ATTRIBUTE}]`)) {
    const walker = editor.ownerDocument.createTreeWalker(boundary, 4);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node as Text;
      for (let index = text.data.lastIndexOf(CARET_BOUNDARY_SENTINEL); index >= 0;
        index = text.data.lastIndexOf(CARET_BOUNDARY_SENTINEL)) {
        text.deleteData(index, CARET_BOUNDARY_SENTINEL.length);
      }
    }
    boundary.removeAttribute(CARET_BOUNDARY_ATTRIBUTE);
  }
};

const marksAtVisualOffset = (
  document: ComposerRichTextDocument,
  offset: number,
): readonly ComposerRichTextMark[] => {
  let position = 0;
  for (const block of document.blocks) {
    if (block.type === "code-block") {
      if (offset <= position + block.text.length) return [];
      position += block.text.length + 1;
      continue;
    }
    for (const span of block.content) {
      const end = position + span.text.length;
      if (offset <= end) return span.marks;
      position = end;
    }
    position += 1;
  }
  return [];
};

export const markdownOffsetForComposerVisualOffset = (
  document: ComposerRichTextDocument,
  offset: number,
): number => {
  const marked = insertAtVisualOffset(
    document,
    offset,
    textSpan(SENTINEL, marksAtVisualOffset(document, offset)),
  );
  const markdown = richTextDocumentToCanonicalMarkdown(marked);
  const index = markdown.indexOf(SENTINEL);
  return index < 0 ? markdown.length : index;
};

export const canonicalComposerSelection = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
): ComposerVisualSelection => ({
  start: markdownOffsetForComposerVisualOffset(document, selection.start),
  end: markdownOffsetForComposerVisualOffset(document, selection.end),
});

export const visualOffsetForComposerMarkdownOffset = (
  document: ComposerRichTextDocument,
  markdownOffset: number,
): number => {
  const length = composerRichTextDocumentPlainText(document).length;
  let closest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset <= length; offset += 1) {
    const candidate = markdownOffsetForComposerVisualOffset(document, offset);
    const nextDistance = Math.abs(candidate - markdownOffset);
    if (nextDistance < distance) {
      closest = offset;
      distance = nextDistance;
    }
    if (candidate === markdownOffset) return offset;
  }
  return closest;
};

const commandMark = (
  command: ComposerRichTextCommand,
  href?: string,
): ComposerRichTextMark | undefined => {
  switch (command) {
    case "bold": return { type: "bold" };
    case "italic": return { type: "italic" };
    case "strikethrough": return { type: "strikethrough" };
    case "inline-code": return { type: "code" };
    case "link": {
      const safe = sanitizeComposerMarkdownLink(href ?? "");
      return safe === undefined ? undefined : { type: "link", href: safe };
    }
    default: return undefined;
  }
};

const placeholderForCommand = (command: ComposerRichTextCommand): string => {
  switch (command) {
    case "bold": return "bold text";
    case "italic": return "italic text";
    case "strikethrough": return "strikethrough text";
    case "link": return "link text";
    case "inline-code": return "code";
    case "code-block": return "code";
    default: return "list item";
  }
};

const selectedSpansHaveMark = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
  type: ComposerRichTextMark["type"],
): boolean => {
  let position = 0;
  let found = false;
  for (const block of document.blocks) {
    if (block.type !== "code-block") {
      for (const span of block.content) {
        const start = position;
        const end = start + span.text.length;
        if (selection.start < end && selection.end > start) {
          found = true;
          if (!span.marks.some((mark) => mark.type === type)) return false;
        }
        position = end;
      }
    } else position += block.text.length;
    position += 1;
  }
  return found;
};

const applyInlineMark = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
  mark: ComposerRichTextMark,
): ComposerRichTextDocument => {
  if (selection.start === selection.end) {
    return insertAtVisualOffset(document, selection.start, textSpan(
      placeholderForCommand(mark.type === "code" ? "inline-code" : mark.type),
      [mark],
    ));
  }
  const remove = mark.type !== "link" && selectedSpansHaveMark(document, selection, mark.type);
  let position = 0;
  const blocks = document.blocks.map((block): ComposerRichTextBlock => {
    if (block.type === "code-block") {
      position += block.text.length + 1;
      return block;
    }
    const content: ComposerRichTextSpan[] = [];
    for (const span of block.content) {
      const start = position;
      const end = start + span.text.length;
      const overlapStart = Math.max(start, selection.start);
      const overlapEnd = Math.min(end, selection.end);
      if (overlapStart >= overlapEnd) content.push(span);
      else {
        const localStart = overlapStart - start;
        const localEnd = overlapEnd - start;
        if (localStart > 0) content.push(textSpan(span.text.slice(0, localStart), span.marks));
        const marks = remove
          ? span.marks.filter((candidate) => candidate.type !== mark.type)
          : [...span.marks.filter((candidate) => candidate.type !== mark.type), mark];
        content.push(textSpan(span.text.slice(localStart, localEnd), marks));
        if (localEnd < span.text.length) {
          content.push(textSpan(span.text.slice(localEnd), span.marks));
        }
      }
      position = end;
    }
    position += 1;
    return { ...block, content };
  });
  return { type: "document", blocks };
};

const selectedBlockRange = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
): readonly [number, number] => {
  if (document.blocks.length === 0) return [0, 0];
  let position = 0;
  let first = -1;
  let last = -1;
  document.blocks.forEach((block, index) => {
    const end = position + blockText(block).length;
    if (selection.end >= position && selection.start <= end) {
      if (first < 0) first = index;
      last = index;
    }
    position = end + 1;
  });
  return [first < 0 ? 0 : first, last < 0 ? 0 : last];
};

const contentLines = (
  content: readonly ComposerRichTextSpan[],
): readonly (readonly ComposerRichTextSpan[])[] => {
  const lines: ComposerRichTextSpan[][] = [[]];
  for (const span of content) {
    const pieces = span.text.split("\n");
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece.length > 0) lines.at(-1)?.push(textSpan(piece, span.marks));
    });
  }
  return lines;
};

const applyList = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
  ordered: boolean,
): ComposerRichTextDocument => {
  const source = document.blocks.length === 0
    ? [paragraph([textSpan("list item")])]
    : [...document.blocks];
  const [first, last] = selectedBlockRange({ type: "document", blocks: source }, selection);
  const replacement: ComposerRichTextBlock[] = [];
  let ordinal = 1;
  for (const block of source.slice(first, last + 1)) {
    const lines = block.type === "code-block"
      ? [[textSpan(block.text)]]
      : contentLines(block.content);
    for (const lineContent of lines) {
      const content = lineContent.length === 0 ? [textSpan("list item")] : lineContent;
      replacement.push(ordered
        ? { type: "ordered-list-item", ordinal: ordinal++, content }
        : { type: "unordered-list-item", content });
    }
  }
  return {
    type: "document",
    blocks: [...source.slice(0, first), ...replacement, ...source.slice(last + 1)],
  };
};

const applyCodeBlock = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
): ComposerRichTextDocument => {
  if (document.blocks.length === 0) {
    return { type: "document", blocks: [{ type: "code-block", text: "code" }] };
  }
  const [first, last] = selectedBlockRange(document, selection);
  const text = document.blocks.slice(first, last + 1).map(blockText).join("\n") || "code";
  return {
    type: "document",
    blocks: [
      ...document.blocks.slice(0, first),
      { type: "code-block", text },
      ...document.blocks.slice(last + 1),
    ],
  };
};

export const applyComposerRichTextFormatting = (
  document: ComposerRichTextDocument,
  selection: ComposerVisualSelection,
  command: ComposerRichTextCommand,
  href?: string,
  activeAtCaret?: boolean,
): Readonly<{
  document: ComposerRichTextDocument;
  selection: ComposerVisualSelection;
  caretMarks?: readonly ComposerRichTextMark[];
}> | undefined => {
  const length = composerRichTextDocumentPlainText(document).length;
  const bounded = {
    start: Math.max(0, Math.min(selection.start, length)),
    end: Math.max(0, Math.min(selection.end, length)),
  };
  if (bounded.end < bounded.start) [bounded.start, bounded.end] = [bounded.end, bounded.start];
  const collapsed = bounded.start === bounded.end;
  const placeholder = placeholderForCommand(command);
  let caretMarks: readonly ComposerRichTextMark[] | undefined;
  let next: ComposerRichTextDocument;
  if (command === "ordered-list" || command === "bulleted-list") {
    next = applyList(document, bounded, command === "ordered-list");
  } else if (command === "code-block") next = applyCodeBlock(document, bounded);
  else {
    const mark = commandMark(command, href);
    if (mark === undefined) return undefined;
    const activeMarks = collapsed ? marksAtVisualOffset(document, bounded.start) : [];
    const deactivate = mark.type !== "link" &&
      (activeAtCaret ?? activeMarks.some((candidate) => candidate.type === mark.type));
    if (deactivate) {
      next = document;
      caretMarks = activeMarks.filter((candidate) => candidate.type !== mark.type);
    } else next = applyInlineMark(document, bounded, mark);
  }
  return {
    document: next,
    selection: collapsed && caretMarks === undefined
      ? { start: bounded.start, end: bounded.start + placeholder.length }
      : bounded,
    ...(caretMarks === undefined ? {} : { caretMarks }),
  };
};
