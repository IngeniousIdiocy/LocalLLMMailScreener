/**
 * GPU Monitoring Module for Apple Silicon Macs
 *
 * Tracks GPU utilization and system memory usage with peak tracking per time block.
 * Designed to gracefully degrade when GPU data is unavailable.
 * Persists last 60 minutes of history to survive restarts.
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Check if GPU monitoring is available on this platform
 */
export function isGpuAvailable() {
  // Disabled in test mode
  if (process.env.NODE_ENV === 'test') return false;

  // Only supported on macOS
  if (process.platform !== 'darwin') return false;

  // Check for Apple Silicon
  const cpuModel = os.cpus()[0]?.model || '';
  if (!cpuModel.includes('Apple')) return false;

  return true;
}

/**
 * Get the GPU/chip name
 */
function getGpuName() {
  try {
    const result = execSync('sysctl -n machdep.cpu.brand_string', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim() || 'Apple Silicon';
  } catch {
    return 'Apple Silicon';
  }
}

/**
 * Sample current GPU utilization
 * Returns percentage 0-100 or null if unavailable
 */
function sampleGpuUtilization() {
  try {
    // Try to get GPU utilization from ioreg
    // This queries the GPU performance state
    const result = execSync(
      'ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep -E "PerformanceStatistics|utilization" | head -20',
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Parse utilization from output - look for patterns like "Device Utilization %" = XX
    const utilizationMatch = result.match(/"Device Utilization %"\s*=\s*(\d+)/i) ||
                             result.match(/"GPU Activity"\s*=\s*(\d+)/i) ||
                             result.match(/utilization[^=]*=\s*(\d+)/i);

    if (utilizationMatch) {
      return Math.min(100, Math.max(0, parseInt(utilizationMatch[1], 10)));
    }

    // Fallback: try powermetrics (may require elevated privileges)
    // Skip this as it typically requires sudo
    return null;
  } catch {
    return null;
  }
}

/**
 * Get current memory stats
 * Uses Node.js os module for reliability
 */
function getMemoryStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  const formatBytes = (bytes) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 100) return `${Math.round(gb)}GB`;
    if (gb >= 10) return `${gb.toFixed(1)}GB`;
    return `${gb.toFixed(2)}GB`;
  };

  return {
    memory_used: used,
    memory_total: total,
    memory_display: `${formatBytes(used)} / ${formatBytes(total)}`
  };
}

/**
 * Create a GPU monitor instance
 * Returns null if GPU monitoring is not available or in test mode
 */
export function createGpuMonitor(config = {}) {
  // Return null in test mode or unsupported platforms
  if (!isGpuAvailable()) return null;

  const {
    sampleIntervalMs = 5000,
    blockDurationMs = 15000,
    historyBlocks = 240,
    statePath = './data/gpu_history.json'
  } = config;

  // State
  let running = false;
  let sampleTimer = null;
  let gpuName = null;
  let lastSample = null;
  let currentBlock = null;
  let history = [];
  let saveTimeout = null;

  /**
   * Load history from file
   */
  const loadHistory = () => {
    try {
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (Array.isArray(data.history)) {
          // Filter out entries older than 60 minutes
          const cutoff = Date.now() - (60 * 60 * 1000);
          history = data.history.filter(h => h.timestamp > cutoff);
        }
      }
    } catch {
      // Ignore errors, start fresh
      history = [];
    }
  };

  /**
   * Save history to file (debounced)
   */
  const saveHistory = () => {
    // Debounce saves to avoid excessive disk writes
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      try {
        // Ensure directory exists
        const dir = path.dirname(statePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Write atomically via temp file
        const tempPath = `${statePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify({ history }, null, 2));
        fs.renameSync(tempPath, statePath);
      } catch {
        // Ignore save errors
      }
    }, 1000);
  };

  /**
   * Take a single sample of GPU and memory stats
   */
  const takeSample = () => {
    const now = Date.now();
    const gpuUtilization = sampleGpuUtilization();
    const memStats = getMemoryStats();

    lastSample = {
      gpu_utilization: gpuUtilization,
      ...memStats,
      timestamp: now
    };

    // Initialize current block if needed
    if (!currentBlock) {
      currentBlock = {
        start_time: now,
        peak_gpu_utilization: gpuUtilization ?? 0,
        sample_count: 1
      };
    } else {
      // Update peak if we have a valid reading
      if (gpuUtilization !== null) {
        currentBlock.peak_gpu_utilization = Math.max(
          currentBlock.peak_gpu_utilization,
          gpuUtilization
        );
      }
      currentBlock.sample_count++;
    }

    // Check if block duration has elapsed
    const blockAge = now - currentBlock.start_time;
    if (blockAge >= blockDurationMs) {
      // Finalize current block and add to history
      history.push({
        timestamp: currentBlock.start_time,
        peak: currentBlock.peak_gpu_utilization
      });

      // Prune old blocks (keep only last 60 minutes)
      const cutoff = now - (60 * 60 * 1000);
      while (history.length > 0 && history[0].timestamp < cutoff) {
        history.shift();
      }
      // Also respect historyBlocks limit
      while (history.length > historyBlocks) {
        history.shift();
      }

      // Save to disk
      saveHistory();

      // Start new block
      currentBlock = {
        start_time: now,
        peak_gpu_utilization: gpuUtilization ?? 0,
        sample_count: 1
      };
    }
  };

  /**
   * Start the GPU monitor
   */
  const start = () => {
    if (running) return;
    running = true;

    // Get GPU name once at startup
    gpuName = getGpuName();

    // Load persisted history
    loadHistory();

    // Take initial sample
    takeSample();

    // Schedule periodic sampling
    sampleTimer = setInterval(takeSample, sampleIntervalMs);

    // Prevent timer from keeping process alive
    if (sampleTimer.unref) sampleTimer.unref();
  };

  /**
   * Stop the GPU monitor
   */
  const stop = () => {
    running = false;
    if (sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    // Final save
    try {
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(statePath, JSON.stringify({ history }, null, 2));
    } catch {
      // Ignore
    }
  };

  /**
   * Get current stats (most recent sample)
   */
  const getCurrentStats = () => lastSample;

  /**
   * Get current in-progress block
   */
  const getCurrentBlock = () => currentBlock;

  /**
   * Get history of completed blocks
   */
  const getHistory = () => [...history];

  /**
   * Get full snapshot for API response
   */
  const getSnapshot = () => {
    if (!running && !lastSample) return null;

    return {
      enabled: true,
      gpu_name: gpuName,
      block_duration_ms: blockDurationMs,
      sample_interval_ms: sampleIntervalMs,
      current: lastSample,
      current_block: currentBlock,
      history: [...history]
    };
  };

  return {
    start,
    stop,
    getCurrentStats,
    getCurrentBlock,
    getHistory,
    getSnapshot
  };
}
