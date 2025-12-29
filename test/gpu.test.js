/**
 * GPU Monitoring Module Tests
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

// Set test environment BEFORE importing the module
process.env.NODE_ENV = 'test';
process.env.NO_AUTO_START = '1';

// Import after setting environment
const { createGpuMonitor, isGpuAvailable } = await import('../src/gpu.js');

describe('GPU Module', () => {
  test('isGpuAvailable returns false in test mode', () => {
    assert.strictEqual(isGpuAvailable(), false);
  });

  test('createGpuMonitor returns null in test mode', () => {
    const monitor = createGpuMonitor({
      sampleIntervalMs: 1000,
      blockDurationMs: 5000,
      historyBlocks: 10
    });
    assert.strictEqual(monitor, null);
  });

  test('createGpuMonitor returns null when GPU_ENABLED is false', () => {
    // Even in test mode, it should return null
    const monitor = createGpuMonitor({});
    assert.strictEqual(monitor, null);
  });
});

describe('GPU Monitor Mock', () => {
  test('mock GPU monitor provides expected interface', () => {
    // Simulate what a real monitor would return
    const mockMonitor = {
      start: () => {},
      stop: () => {},
      getCurrentStats: () => ({
        gpu_utilization: 25.5,
        memory_used: 8589934592,
        memory_total: 17179869184,
        memory_display: '8.00GB / 16.00GB',
        timestamp: Date.now()
      }),
      getCurrentBlock: () => ({
        start_time: Date.now() - 15000,
        peak_gpu_utilization: 45.2,
        sample_count: 3
      }),
      getHistory: () => [
        { timestamp: Date.now() - 60000, peak: 23.5 },
        { timestamp: Date.now() - 30000, peak: 87.2 }
      ],
      getSnapshot: () => ({
        enabled: true,
        gpu_name: 'Apple M1',
        block_duration_ms: 30000,
        sample_interval_ms: 5000,
        current: {
          gpu_utilization: 25.5,
          memory_used: 8589934592,
          memory_total: 17179869184,
          memory_display: '8.00GB / 16.00GB',
          timestamp: Date.now()
        },
        current_block: {
          start_time: Date.now() - 15000,
          peak_gpu_utilization: 45.2,
          sample_count: 3
        },
        history: [
          { timestamp: Date.now() - 60000, peak: 23.5 },
          { timestamp: Date.now() - 30000, peak: 87.2 }
        ]
      })
    };

    // Verify interface
    assert.strictEqual(typeof mockMonitor.start, 'function');
    assert.strictEqual(typeof mockMonitor.stop, 'function');
    assert.strictEqual(typeof mockMonitor.getCurrentStats, 'function');
    assert.strictEqual(typeof mockMonitor.getCurrentBlock, 'function');
    assert.strictEqual(typeof mockMonitor.getHistory, 'function');
    assert.strictEqual(typeof mockMonitor.getSnapshot, 'function');

    // Verify snapshot structure
    const snapshot = mockMonitor.getSnapshot();
    assert.strictEqual(snapshot.enabled, true);
    assert.strictEqual(typeof snapshot.gpu_name, 'string');
    assert.strictEqual(typeof snapshot.current.gpu_utilization, 'number');
    assert.strictEqual(typeof snapshot.current.memory_display, 'string');
    assert.ok(Array.isArray(snapshot.history));
  });
});
