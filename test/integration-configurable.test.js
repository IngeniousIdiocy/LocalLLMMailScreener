process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert';
import { startApp } from '../src/index.js';
import { callLLM } from '../src/llm.js';
import { createMockGmail, buildEmails, createTwilioMock, tmpStatePath, cleanupFile } from './helpers.js';

const useRealLLM = process.env.TEST_REAL_LLM === '1';
const useRealGmail = process.env.TEST_REAL_GMAIL === '1';
const useRealTwilio = process.env.TEST_REAL_TWILIO === '1';
const logLLM = process.env.TEST_LLM_DEBUG === '1';

const hasGmailCreds =
  process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN;

const realTwilioWarn = () => {
  if (useRealTwilio) {
    throw new Error('Real Twilio not supported in tests; keep TEST_REAL_TWILIO unset to avoid live SMS.');
  }
};

test(
  'real LLM with mocked Gmail and Twilio',
  { skip: !useRealLLM },
  async () => {
    realTwilioWarn();
    const emails = buildEmails(['m1']);
    const mockGmail = createMockGmail(emails);
    const twilioMock = createTwilioMock('success');
    const statePath = tmpStatePath();
    const appRunner = await startApp({
      configOverrides: {
        port: 0,
        statePath,
      pollIntervalMs: 2000,
      pollMaxResults: 5,
      dryRun: true
    },
    gmailClient: mockGmail,
    twilioClient: twilioMock,
    // Use real LLM; optionally log
    llmCaller: logLLM
      ? async (opts) => {
          const start = Date.now();
          const res = await callLLM(opts);
          console.log(
            '[LLM DEBUG]',
            opts.emailObj?.message_id,
            'latency_ms=',
            res.latencyMs,
            'tokens=',
            res.tokens,
            'content=',
            res.content
          );
          return res;
        }
      : undefined,
    llmHealthChecker: undefined,
      startPolling: false,
      skipTwilioStartupCheck: true,
      startServer: false
    });
    try {
      await appRunner.pollNow();
      const state = appRunner.ctx.stateManager.getState();
      assert.ok(state.processed.m1, 'should mark message processed even with real LLM');
    } finally {
      await appRunner.stop();
      await cleanupFile(statePath);
    }
  }
);

test(
  'real Gmail + real LLM with mocked Twilio',
  { skip: !(useRealLLM && useRealGmail && hasGmailCreds) },
  async () => {
    realTwilioWarn();
    const twilioMock = createTwilioMock('success');
    const statePath = tmpStatePath();
    const appRunner = await startApp({
      configOverrides: {
        port: 0,
        statePath,
        pollIntervalMs: 2000,
        pollMaxResults: 5,
        dryRun: true // extra guard; Twilio still mocked
      },
      // Use real Gmail client and LLM caller (default)
      twilioClient: twilioMock,
      startPolling: false,
      skipTwilioStartupCheck: true,
      startServer: false
    });
    try {
      await appRunner.pollNow();
      const stats = appRunner.ctx.stateManager.getState().stats;
      assert.ok(!stats.gmail.last_error, 'Gmail should not report errors');
    } finally {
      await appRunner.stop();
      await cleanupFile(statePath);
    }
  }
);
