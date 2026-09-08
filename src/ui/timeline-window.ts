/** A runtime-neutral description of one variable-height timeline row. */
export interface TimelineWindowRow {
  readonly id: string;
  readonly estimatedHeight: number;
  readonly measuredHeight?: number;
}

/** The first visible row and the viewport's distance into that row. */
export interface TimelineWindowAnchor {
  readonly rowId: string;
  readonly offsetWithinRow: number;
}

export interface TimelineWindowInput {
  readonly rows: readonly TimelineWindowRow[];
  readonly viewportOffset: number;
  readonly viewportHeight: number;
  /** Extra pixels to mount before and after the visible viewport. */
  readonly overscan: number;
}

export interface TimelineWindow {
  /** Inclusive index of the first mounted row. */
  readonly startIndex: number;
  /** Exclusive index after the last mounted row. */
  readonly endIndex: number;
  readonly mountedRowIds: readonly string[];
  readonly beforeSpacerHeight: number;
  readonly afterSpacerHeight: number;
  readonly totalHeight: number;
  readonly viewportOffset: number;
  readonly anchor?: TimelineWindowAnchor;
}

export interface TimelineAnchorOffsetCorrectionInput {
  readonly rows: readonly TimelineWindowRow[];
  readonly anchor: TimelineWindowAnchor;
  readonly viewportHeight: number;
  /** Used when the anchor row was removed. Defaults to the start. */
  readonly fallbackViewportOffset?: number;
}

const MAX_LAYOUT_HEIGHT = Number.MAX_SAFE_INTEGER;

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_LAYOUT_HEIGHT)
    : 0;

const rowHeight = (row: TimelineWindowRow): number => {
  const estimate = finiteNonNegative(row.estimatedHeight);
  if (row.measuredHeight === undefined || !Number.isFinite(row.measuredHeight) || row.measuredHeight < 0) {
    return estimate;
  }
  return finiteNonNegative(row.measuredHeight);
};

const addHeight = (left: number, right: number): number =>
  Math.min(left + right, MAX_LAYOUT_HEIGHT);

interface TimelineLayout {
  readonly heights: readonly number[];
  readonly offsets: readonly number[];
  readonly totalHeight: number;
}

const createLayout = (rows: readonly TimelineWindowRow[]): TimelineLayout => {
  const ids = new Set<string>();
  const heights: number[] = [];
  const offsets: number[] = [0];
  let totalHeight = 0;

  for (const row of rows) {
    if (ids.has(row.id)) {
      throw new RangeError(`Timeline row IDs must be unique: ${row.id}`);
    }
    ids.add(row.id);
    const height = rowHeight(row);
    heights.push(height);
    totalHeight = addHeight(totalHeight, height);
    offsets.push(totalHeight);
  }

  return { heights, offsets, totalHeight };
};

const clampViewportOffset = (
  viewportOffset: number,
  viewportHeight: number,
  totalHeight: number,
): number => Math.min(
  finiteNonNegative(viewportOffset),
  Math.max(0, totalHeight - Math.min(viewportHeight, totalHeight)),
);

/** Finds the first row whose bottom edge is after the supplied offset. */
const firstRowEndingAfter = (offsets: readonly number[], offset: number): number => {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((offsets[middle + 1] ?? MAX_LAYOUT_HEIGHT) > offset) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
};

/** Finds the first row whose top edge is at or after the supplied offset. */
const firstRowStartingAtOrAfter = (offsets: readonly number[], offset: number): number => {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((offsets[middle] ?? MAX_LAYOUT_HEIGHT) >= offset) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
};

/**
 * Calculates a bounded mounted range using each row's measured height when
 * available and its estimate otherwise.
 */
export const calculateTimelineWindow = (input: TimelineWindowInput): TimelineWindow => {
  const layout = createLayout(input.rows);
  const viewportHeight = finiteNonNegative(input.viewportHeight);
  const overscan = finiteNonNegative(input.overscan);
  const viewportOffset = clampViewportOffset(
    input.viewportOffset,
    viewportHeight,
    layout.totalHeight,
  );
  const visibleEnd = Math.min(
    addHeight(viewportOffset, viewportHeight),
    layout.totalHeight,
  );
  const windowStart = Math.max(0, viewportOffset - overscan);
  const windowEnd = Math.min(addHeight(visibleEnd, overscan), layout.totalHeight);

  let startIndex = firstRowEndingAfter(layout.offsets, windowStart);
  let endIndex = firstRowStartingAtOrAfter(layout.offsets, windowEnd);
  if (windowEnd <= windowStart || startIndex >= input.rows.length) {
    startIndex = Math.min(startIndex, input.rows.length);
    endIndex = startIndex;
  } else {
    endIndex = Math.max(startIndex, Math.min(endIndex, input.rows.length));
  }

  const beforeSpacerHeight = layout.offsets[startIndex] ?? layout.totalHeight;
  const mountedEndOffset = layout.offsets[endIndex] ?? layout.totalHeight;
  const afterSpacerHeight = Math.max(0, layout.totalHeight - mountedEndOffset);
  const anchorIndex = firstRowEndingAfter(layout.offsets, viewportOffset);
  const anchorRow = input.rows[anchorIndex];
  const anchorHeight = layout.heights[anchorIndex];
  const anchor = anchorRow === undefined || anchorHeight === undefined || anchorHeight === 0
    ? undefined
    : Object.freeze({
      rowId: anchorRow.id,
      offsetWithinRow: Math.min(
        Math.max(0, viewportOffset - (layout.offsets[anchorIndex] ?? 0)),
        anchorHeight,
      ),
    });

  return Object.freeze({
    startIndex,
    endIndex,
    mountedRowIds: Object.freeze(
      input.rows.slice(startIndex, endIndex).map(({ id }) => id),
    ),
    beforeSpacerHeight,
    afterSpacerHeight,
    totalHeight: layout.totalHeight,
    viewportOffset,
    ...(anchor === undefined ? {} : { anchor }),
  });
};

/**
 * Restores a captured anchor against a changed row layout. The returned value
 * is the absolute corrected viewport offset (not a signed delta), ready to be
 * assigned to scrollTop. If the anchor disappeared, the bounded fallback is
 * returned instead.
 */
export const calculateTimelineAnchorOffsetCorrection = (
  input: TimelineAnchorOffsetCorrectionInput,
): number => {
  const layout = createLayout(input.rows);
  const viewportHeight = finiteNonNegative(input.viewportHeight);
  const anchorIndex = input.rows.findIndex(({ id }) => id === input.anchor.rowId);

  if (anchorIndex === -1) {
    return clampViewportOffset(
      input.fallbackViewportOffset ?? 0,
      viewportHeight,
      layout.totalHeight,
    );
  }

  const anchorTop = layout.offsets[anchorIndex] ?? 0;
  const anchorHeight = layout.heights[anchorIndex] ?? 0;
  const offsetWithinRow = Math.min(
    finiteNonNegative(input.anchor.offsetWithinRow),
    anchorHeight,
  );
  return clampViewportOffset(
    addHeight(anchorTop, offsetWithinRow),
    viewportHeight,
    layout.totalHeight,
  );
};
