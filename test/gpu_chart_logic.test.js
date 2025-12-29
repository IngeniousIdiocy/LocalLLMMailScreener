import { test, describe } from 'node:test';
import assert from 'node:assert';
import { computeGpuChartGrid, gpuChartConstants } from '../src/gpu_chart_logic.js';

const WIDTH = 300;
const HEIGHT = 150;
const BLOCK_DURATION = 15000;
const BASE_NOW = 3_600_000; // 60 minutes in ms, aligned to block duration

describe('gpu_chart_logic', () => {
  test('keeps column assignment stable within a block interval', () => {
    const baseline = computeGpuChartGrid({
      history: [],
      width: WIDTH,
      height: HEIGHT,
      now: BASE_NOW,
      blockDurationMs: BLOCK_DURATION
    });
    const { timePerColumn } = baseline.layout;

    // Place a block right before a column boundary so small time drift would
    // previously push it into the next column and change its color.
    const nearBoundaryAge = 6 * timePerColumn - 200; // 200ms before the boundary
    const blockTs = BASE_NOW - nearBoundaryAge;

    const first = computeGpuChartGrid({
      history: [{ timestamp: blockTs, peak: 82 }],
      width: WIDTH,
      height: HEIGHT,
      now: BASE_NOW,
      blockDurationMs: BLOCK_DURATION
    });
    const later = computeGpuChartGrid({
      history: [{ timestamp: blockTs, peak: 82 }],
      width: WIDTH,
      height: HEIGHT,
      now: BASE_NOW + 1000, // 1 second drift (less than block duration)
      blockDurationMs: BLOCK_DURATION
    });

    assert.ok(first.columns.length > 0, 'first render should include the block');
    assert.ok(later.columns.length > 0, 'later render should include the block');
    assert.strictEqual(
      first.columns[0].column,
      later.columns[0].column,
      'column index should remain stable after minor time drift'
    );

    // Legacy behavior (using unsnapped "now") would jitter into another column
    const legacyColNow = Math.floor((BASE_NOW - blockTs) / timePerColumn);
    const legacyColLater = Math.floor((BASE_NOW + 1000 - blockTs) / timePerColumn);
    assert.notStrictEqual(
      legacyColNow,
      legacyColLater,
      'legacy calculation would have jittered into a new column'
    );
  });

  test('drops samples older than 60 minutes and keeps the latest peak', () => {
    const res = computeGpuChartGrid({
      history: [
        { timestamp: BASE_NOW - gpuChartConstants.SIXTY_MINUTES_MS - 1000, peak: 99 },
        { timestamp: BASE_NOW - 5 * 60 * 1000, peak: 44 }
      ],
      width: WIDTH,
      height: HEIGHT,
      now: BASE_NOW,
      blockDurationMs: BLOCK_DURATION
    });

    assert.strictEqual(res.columns.length, 1, 'only the recent block should render');
    assert.strictEqual(res.columns[0].peak, 44);
  });

  test('computes a consistent square grid that fully spans 60 minutes', () => {
    const res = computeGpuChartGrid({
      history: [{ timestamp: BASE_NOW - 30 * 60 * 1000, peak: 60 }],
      width: WIDTH,
      height: HEIGHT,
      now: BASE_NOW,
      blockDurationMs: BLOCK_DURATION
    });

    const { squareSize, numColumns, actualWidth, actualHeight, gap, levels } = res.layout;

    assert.ok(squareSize >= 2, 'square size respects minimum');
    assert.ok(numColumns >= 1, 'at least one column is computed');
    assert.ok(actualWidth > 0 && actualHeight > 0, 'chart has drawable dimensions');
    assert.strictEqual(res.xLabels.length, 7, 'x-axis labels cover the 60m window in 10m steps');
    assert.strictEqual(levels, 15);
    assert.strictEqual(gap, gpuChartConstants.GAP);
  });
});
