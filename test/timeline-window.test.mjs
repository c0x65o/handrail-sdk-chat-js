import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  calculateTimelineAnchorOffsetCorrection,
  calculateTimelineWindow,
} from "../dist/ui/index.js";

const heightOf = (row) => row.measuredHeight ?? row.estimatedHeight;

test("bounds a 5,000-row mixed-height timeline to the viewport and pixel overscan", () => {
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    id: `row-${index}`,
    estimatedHeight: 36 + (index % 7) * 13,
    ...(index % 3 === 0 ? { measuredHeight: 42 + (index % 11) * 17 } : {}),
  }));
  const window = calculateTimelineWindow({
    rows,
    viewportOffset: 137_500,
    viewportHeight: 720,
    overscan: 360,
  });
  const mountedHeight = rows
    .slice(window.startIndex, window.endIndex)
    .reduce((total, row) => total + heightOf(row), 0);

  assert.ok(window.startIndex > 0);
  assert.ok(window.endIndex < rows.length);
  assert.ok(window.mountedRowIds.length < 50);
  assert.deepEqual(
    window.mountedRowIds,
    rows.slice(window.startIndex, window.endIndex).map(({ id }) => id),
  );
  assert.equal(
    window.beforeSpacerHeight + mountedHeight + window.afterSpacerHeight,
    window.totalHeight,
  );
});

test("clamps start and end scrolling boundaries without unbounded spacers", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `boundary-${index}`,
    estimatedHeight: 40 + index,
  }));
  const atStart = calculateTimelineWindow({
    rows,
    viewportOffset: -500,
    viewportHeight: 200,
    overscan: 80,
  });
  const atEnd = calculateTimelineWindow({
    rows,
    viewportOffset: Number.MAX_SAFE_INTEGER,
    viewportHeight: 200,
    overscan: 80,
  });

  assert.equal(atStart.startIndex, 0);
  assert.equal(atStart.beforeSpacerHeight, 0);
  assert.equal(atStart.viewportOffset, 0);
  assert.equal(atEnd.endIndex, rows.length);
  assert.equal(atEnd.afterSpacerHeight, 0);
  assert.equal(atEnd.viewportOffset, atEnd.totalHeight - 200);
  for (const value of [
    atStart.beforeSpacerHeight,
    atStart.afterSpacerHeight,
    atEnd.beforeSpacerHeight,
    atEnd.afterSpacerHeight,
  ]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0);
  }
});

test("replaces estimates with measurements and restores the captured anchor", () => {
  const estimatedRows = Array.from({ length: 8 }, (_, index) => ({
    id: `measured-${index}`,
    estimatedHeight: 100,
  }));
  const before = calculateTimelineWindow({
    rows: estimatedRows,
    viewportOffset: 250,
    viewportHeight: 200,
    overscan: 0,
  });
  const measuredRows = estimatedRows.map((row, index) => ({
    ...row,
    ...(index === 0 ? { measuredHeight: 160 } : {}),
    ...(index === 1 ? { measuredHeight: 140 } : {}),
  }));

  assert.deepEqual(before.anchor, {
    rowId: "measured-2",
    offsetWithinRow: 50,
  });
  assert.equal(calculateTimelineAnchorOffsetCorrection({
    rows: measuredRows,
    anchor: before.anchor,
    viewportHeight: 200,
  }), 350);
  assert.equal(calculateTimelineWindow({
    rows: measuredRows,
    viewportOffset: 350,
    viewportHeight: 200,
    overscan: 0,
  }).anchor.rowId, "measured-2");
});

test("preserves an anchor when variable-height rows are prepended", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    id: `existing-${index}`,
    estimatedHeight: 100,
  }));
  const before = calculateTimelineWindow({
    rows,
    viewportOffset: 125,
    viewportHeight: 200,
    overscan: 50,
  });
  const prepended = [
    { id: "older-0", estimatedHeight: 40 },
    { id: "older-1", estimatedHeight: 60 },
    ...rows,
  ];
  const correctedOffset = calculateTimelineAnchorOffsetCorrection({
    rows: prepended,
    anchor: before.anchor,
    viewportHeight: 200,
  });
  const after = calculateTimelineWindow({
    rows: prepended,
    viewportOffset: correctedOffset,
    viewportHeight: 200,
    overscan: 50,
  });

  assert.equal(correctedOffset, 225);
  assert.deepEqual(after.anchor, before.anchor);
});

test("keeps removal, reorder, and malformed height results finite and non-negative", () => {
  const rows = [
    { id: "a", estimatedHeight: 80 },
    { id: "b", estimatedHeight: 90 },
    { id: "c", estimatedHeight: 100 },
    { id: "d", estimatedHeight: 110 },
  ];
  const anchor = calculateTimelineWindow({
    rows,
    viewportOffset: 185,
    viewportHeight: 100,
    overscan: 25,
  }).anchor;
  const changedRows = [
    { id: "d", estimatedHeight: Number.NaN, measuredHeight: -1 },
    { id: "c", estimatedHeight: 100, measuredHeight: 125 },
    { id: "a", estimatedHeight: Number.POSITIVE_INFINITY },
  ];
  const changed = calculateTimelineWindow({
    rows: changedRows,
    viewportOffset: 999,
    viewportHeight: 100,
    overscan: Number.NaN,
  });
  const correction = calculateTimelineAnchorOffsetCorrection({
    rows: changedRows,
    anchor,
    viewportHeight: 100,
    fallbackViewportOffset: 999,
  });
  const missingAnchorCorrection = calculateTimelineAnchorOffsetCorrection({
    rows: changedRows,
    anchor: { rowId: "removed", offsetWithinRow: Number.NaN },
    viewportHeight: 100,
    fallbackViewportOffset: 999,
  });

  for (const value of [
    changed.beforeSpacerHeight,
    changed.afterSpacerHeight,
    changed.totalHeight,
    changed.viewportOffset,
    correction,
    missingAnchorCorrection,
  ]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0);
  }
});

test("has no runtime, React, DOM, client, server, transport, or test imports", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../src/ui/timeline-window.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/(?:import|export)\s+[^;]*?from\s+["']([^"']+)["']/g)]
    .map((match) => match[1]);

  assert.deepEqual(imports, []);
  assert.doesNotMatch(source, /\b(?:React|Document|HTMLElement|Window)\b/);
  assert.doesNotMatch(imports.join("\n"), /(?:react|dom|client|server|transport|testing|node:)/i);
});
