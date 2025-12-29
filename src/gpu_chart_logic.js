const SIXTY_MINUTES_MS = 60 * 60 * 1000;
const LEVELS = 15;
const GAP = 2;

export function computeGpuChartGrid(options = {}) {
  const {
    history = [],
    currentBlock = null,
    blockDurationMs = 15000,
    width,
    height,
    now = Date.now()
  } = options;

  const squareSize = Math.max(2, Math.ceil(((height || 0) - (LEVELS - 1) * GAP) / LEVELS));
  const numColumns = Math.max(1, Math.floor(((width || 0) - GAP) / (squareSize + GAP)));

  const actualHeight = LEVELS * squareSize + (LEVELS - 1) * GAP;
  const actualWidth = numColumns * squareSize + (numColumns - 1) * GAP;
  const offsetX = Math.floor(((width || 0) - actualWidth) / 2);
  const offsetY = (height || 0) - actualHeight;
  const timePerColumn = SIXTY_MINUTES_MS / numColumns;

  // Snap "now" to the nearest block boundary to avoid small drifts re-bucketing columns
  const snappedNow = Math.floor(now / blockDurationMs) * blockDurationMs;
  const blocks = [...history];

  if (currentBlock?.start_time) {
    blocks.push({
      timestamp: currentBlock.start_time,
      peak: currentBlock.peak_gpu_utilization || 0,
      inProgress: true
    });
  }

  blocks.sort((a, b) => a.timestamp - b.timestamp);

  const columns = Array.from({ length: numColumns }, () => null);

  blocks.forEach((block) => {
    const age = snappedNow - block.timestamp;
    if (age < 0 || age > SIXTY_MINUTES_MS) return;

    const column = Math.floor(age / timePerColumn);
    if (column < 0 || column >= numColumns) return;

    const peak = block.peak || 0;
    const inProgress = !!block.inProgress;
    const existing = columns[column];

    if (!existing || peak > existing.peak) {
      columns[column] = { column, peak, inProgress };
    } else if (existing && peak === existing.peak && inProgress) {
      columns[column].inProgress = true;
    }
  });

  const xLabels = [];
  const windowStart = snappedNow - SIXTY_MINUTES_MS;
  for (let i = 0; i <= 6; i++) {
    const labelTime = new Date(windowStart + i * 10 * 60 * 1000);
    xLabels.push(labelTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  }

  return {
    columns: columns.filter(Boolean),
    layout: {
      squareSize,
      numColumns,
      actualWidth,
      actualHeight,
      offsetX,
      offsetY,
      timePerColumn,
      gap: GAP,
      levels: LEVELS
    },
    xLabels,
    snappedNow
  };
}

export const gpuChartConstants = { SIXTY_MINUTES_MS, LEVELS, GAP };

// Expose helper for the browser dashboard without forcing imports there
if (typeof window !== 'undefined') {
  window.gpuChartLogic = { computeGpuChartGrid, gpuChartConstants };
}
