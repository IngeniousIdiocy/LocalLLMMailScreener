import { test } from 'node:test';
import assert from 'node:assert';

import { computeGpuChartColumns } from '../src/gpu_chart_math.js';

test('spreads a long block across overlapping columns when columns are narrower than the block', () => {
  const now = 1_000_000;
  const blockDurationMs = 30_000;
  const width = 4000;
  const height = 160;
  const history = [{ timestamp: now - 40_000, peak: 90 }];

  const chart = computeGpuChartColumns({
    width,
    height,
    history,
    currentBlock: null,
    blockDurationMs,
    nowMs: now
  });

  assert.ok(chart.timePerColumn < blockDurationMs, 'column width should be smaller than block duration');
  const cols = chart.aggregated.map((c) => c.column).sort((a, b) => a - b);
  assert.ok(cols.length > 1, 'block should span more than one column');
  assert.strictEqual(cols[cols.length - 1] - cols[0] + 1, cols.length, 'spanned columns should be contiguous');
});

test('keeps a completed block within a single column when columns are wider than the block duration', () => {
  const now = 2_000_000;
  const blockDurationMs = 15_000;
  const width = 320;
  const height = 160;
  const history = [{ timestamp: now - 20_000, peak: 55 }];

  const chart = computeGpuChartColumns({
    width,
    height,
    history,
    currentBlock: null,
    blockDurationMs,
    nowMs: now
  });

  assert.ok(chart.timePerColumn > blockDurationMs, 'column width should exceed block duration');
  assert.strictEqual(chart.aggregated.length, 1, 'block should stay within a single column');
  assert.strictEqual(chart.aggregated[0].peak, 55);
});

test('marks every overlapped column as in-progress for the current block', () => {
  const now = 3_000_000;
  const width = 4000;
  const height = 160;
  const blockDurationMs = 30_000;

  const chart = computeGpuChartColumns({
    width,
    height,
    history: [],
    currentBlock: { start_time: now - 10_000, peak_gpu_utilization: 70 },
    blockDurationMs,
    nowMs: now
  });

  const inProgressCols = chart.aggregated.filter((c) => c.inProgress).map((c) => c.column);
  assert.ok(inProgressCols.includes(0), 'latest column should reflect in-progress data');
  assert.ok(inProgressCols.length >= 1, 'in-progress block should mark at least one column');
});
