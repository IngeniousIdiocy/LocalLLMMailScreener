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

test('handles LLM timeout gracefully', async () => {
  const emails = buildEmails(['slow1']);
  const mockGmail = createMockGmail(emails);
  const llmStub = makeLLMStub(fixtures.llm.slow);
  const twilioMock = createTwilioMock('success');

  const statePath = tmpStatePath();
  cleanupTasks.push(() => cleanupFile(statePath));

  const appRunner = await startApp({
    configOverrides: {
      port: 0,
      statePath,
      llmTimeoutMs: 100,
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
  assert.ok(state.processed.slow1);
  assert.strictEqual(state.stats.notifications_sent, 0);
  assert.ok(state.stats.llm.last_error);
  assert.strictEqual(state.recent_sends.length, 0);
});
