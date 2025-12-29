// Utility functions for GPU chart rendering (shared between dashboard and tests)

export const GPU_CHART_CONSTANTS = {
  LEVELS: 15,
  GAP: 2,
  WINDOW_MS: 60 * 60 * 1000
};

/**
 * Compute chart geometry and aggregated GPU blocks for rendering.
 * This is pure and does not touch the DOM; callers provide width/height.
 */
export function computeGpuChartColumns({
  width,
  height,
  history = [],
  currentBlock = null,
  blockDurationMs = 15000,
  nowMs = Date.now()
}) {
  const { LEVELS, GAP, WINDOW_MS } = GPU_CHART_CONSTANTS;

  // Guard against invalid dimensions
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 0);
  const safeHeight = Math.max(1, Number.isFinite(height) ? height : 0);

  // Square size and grid geometry
  const squareSize = Math.max(2, Math.ceil((safeHeight - (LEVELS - 1) * GAP) / LEVELS));
  const numColumns = Math.max(1, Math.floor((safeWidth - GAP) / (squareSize + GAP)));
  const actualHeight = LEVELS * squareSize + (LEVELS - 1) * GAP;
  const actualWidth = numColumns * squareSize + (numColumns - 1) * GAP;
  const offsetX = Math.floor((safeWidth - actualWidth) / 2);
  const offsetY = safeHeight - actualHeight;
  const timePerColumn = WINDOW_MS / numColumns;

  // Build combined block list (history + current)
  const blocks = [...(history || [])];
  if (currentBlock?.start_time) {
    blocks.push({
      timestamp: currentBlock.start_time,
      peak: currentBlock.peak_gpu_utilization || 0,
      inProgress: true
    });
  }
  blocks.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const windowEnd = nowMs;
  const windowStart = windowEnd - WINDOW_MS;
  const aggregated = [];

  for (let col = 0; col < numColumns; col++) {
    // Column bounds in absolute timestamps (older -> newer)
    const colOlderAge = (col + 1) * timePerColumn;
    const colNewerAge = col * timePerColumn;
    const colStartTs = windowEnd - colOlderAge;
    const colEndTs = windowEnd - colNewerAge;

    let maxPeak = 0;
    let hasData = false;
    let isInProgress = false;

    for (const block of blocks) {
      const blockStart = block.timestamp || 0;
      const blockEnd = Math.min(blockStart + blockDurationMs, windowEnd);

      // Skip blocks fully outside the window
      if (blockEnd <= windowStart || blockStart >= windowEnd) continue;

      // Check interval overlap instead of just the start timestamp
      const overlaps = blockStart < colEndTs && blockEnd > colStartTs;
      if (overlaps) {
        hasData = true;
        maxPeak = Math.max(maxPeak, block.peak || 0);
        if (block.inProgress) isInProgress = true;
      }
    }

    if (hasData) {
      aggregated.push({
        column: col,
        peak: maxPeak,
        inProgress: isInProgress,
        x: offsetX + actualWidth - (col + 1) * (squareSize + GAP) + GAP
      });
    }
  }

  return {
    aggregated,
    squareSize,
    numColumns,
    actualWidth,
    actualHeight,
    offsetX,
    offsetY,
    timePerColumn,
    nowMs
  };
}
