process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert';
import { startApp } from '../src/index.js';
import {
  buildEmails,
  createMockGmail,
  createTwilioMock,
  makeLLMStub,
  cleanupFile,
  tmpStatePath
} from './helpers.js';

test('LLM queue drops oldest when over capacity and records stats', async () => {
  const emails = buildEmails(['m1', 'm2', 'bad1', 'twiliofail1']);
  const gmailClient = createMockGmail(emails);
  const llmStub = makeLLMStub({
    default: { notify: false, tokens: 100, latencyMs: 10 }
  });
  const statePath = tmpStatePath();
  const app = await startApp({
    configOverrides: {
      port: 0,
      statePath,
      pollIntervalMs: 1000,
      pollMaxResults: 10,
      maxLlmConcurrency: 1,
      maxLlmQueue: 2,
      dryRun: true,
      notificationService: 'twilio'
    },
    gmailClient,
    llmCaller: llmStub.caller,
    llmHealthChecker: llmStub.health,
    twilioClient: createTwilioMock('success'),
    startPolling: false,
    skipTwilioStartupCheck: true,
    startServer: false
  });

  try {
    await app.pollNow();
    const state = app.ctx.stateManager.getState();
    const queueStats = state.stats.llm_queue;

    assert.strictEqual(queueStats.dropped_total, 2, 'should drop oldest emails when queue exceeds cap');
    assert.strictEqual(queueStats.depth, 0, 'queue should drain after processing');
    assert.strictEqual(queueStats.last_dropped_id, 'bad1');

    assert.strictEqual(state.processed.m2.status, 'dropped');
    assert.strictEqual(state.processed.bad1.status, 'dropped');
    assert.strictEqual(state.processed.m1.status, 'ok');
    assert.strictEqual(state.processed.twiliofail1.status, 'ok');
    assert.strictEqual(state.stats.llm_requests, 2, 'only processed emails should hit LLM');
  } finally {
    await app.stop();
    await cleanupFile(statePath);
  }
});

test('computes average TPS over recent decisions', async () => {
  const emails = buildEmails(['m1', 'm2', 'slow1']);
  const gmailClient = createMockGmail(emails);
  const llmStub = makeLLMStub({
    m1: { notify: false, tokens: 3000, latencyMs: 3000 },
    m2: { notify: false, tokens: 2000, latencyMs: 2000 },
    slow1: { notify: false, tokens: 1000, latencyMs: 1000 },
    default: { notify: false, tokens: 500, latencyMs: 500 }
  });
  const statePath = tmpStatePath();
  const app = await startApp({
    configOverrides: {
      port: 0,
      statePath,
      pollIntervalMs: 1000,
      pollMaxResults: 10,
      maxLlmConcurrency: 2,
      maxLlmQueue: 10,
      dryRun: true,
      notificationService: 'twilio'
    },
    gmailClient,
    llmCaller: llmStub.caller,
    llmHealthChecker: llmStub.health,
    twilioClient: createTwilioMock('success'),
    startPolling: false,
    skipTwilioStartupCheck: true,
    startServer: false
  });

  try {
    await app.pollNow();
    const status = app.getStatus();
    const tps = status.stats.llm_tps;

    assert.strictEqual(tps.samples, 3);
    assert.strictEqual(tps.avg_tps, 1000);
    assert.strictEqual(status.stats.llm_queue.dropped_total, 0);
  } finally {
    await app.stop();
    await cleanupFile(statePath);
  }
});
