process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  buildEmails,
  createMockGmail,
  makeLLMStub,
  createTwilioMock,
  tmpStatePath,
  cleanupFile,
  fixtures
} from './helpers.js';

const { startApp } = await import('../src/index.js');

let cleanupTasks = [];
afterEach(async () => {
  for (const fn of cleanupTasks.reverse()) {
    await fn();
  }
  cleanupTasks = [];
});

test('processes emails and sends SMS when notify=true', async () => {
  const emails = buildEmails(['m1', 'm2']);
  const mockGmail = createMockGmail(emails);
  const llmStub = makeLLMStub(fixtures.llm.positive);
  const twilioMock = createTwilioMock('success');

  const statePath = tmpStatePath();
  cleanupTasks.push(() => cleanupFile(statePath));

  const appRunner = await startApp({
    configOverrides: {
      port: 0,
      statePath,
      pollIntervalMs: 1000,
      pollMaxResults: 10,
      llmTimeoutMs: 2000,
      twilioFrom: '+10000000000',
      twilioTo: '+19999999999'
    },
    gmailClient: mockGmail,
    twilioClient: twilioMock,
    llmCaller: llmStub.caller,
    llmHealthChecker: llmStub.health,
    startPolling: false,
    skipTwilioStartupCheck: true,
    startServer: false
  });
  cleanupTasks.push(() => appRunner.stop());

  await appRunner.pollNow();

  const state = appRunner.ctx.stateManager.getState();
  assert.ok(state.processed.m1, 'message m1 should be processed');
  assert.ok(state.processed.m2, 'message m2 should be processed');
  assert.strictEqual(state.stats.notifications_sent, 1);
  assert.strictEqual(state.recent_sends.length, 1);
  assert.match(state.recent_sends[0].twilio_sid, /^SM/);
  assert.ok(state.stats.tokens_total_est >= 70);

  const status = appRunner.getStatus();
  assert.ok(status.health.gmail.ok);
  assert.ok(status.health.llm.ok);
  assert.ok(status.health.twilio.ok);
});
