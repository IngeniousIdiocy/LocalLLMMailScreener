process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert';
import { startApp } from '../src/index.js';
import { callLLM } from '../src/llm.js';
import {
  fixtures,
  buildEmailsFromRawFiles,
  createMockGmail,
  createTwilioMock,
  tmpStatePath,
  cleanupFile,
  subjectFromRaw
} from './helpers.js';

const useRealLLM = process.env.TEST_REAL_LLM === '1';
const logLLM = process.env.TEST_LLM_DEBUG === '1';

const runCase = async (entry) => {
  const emails = buildEmailsFromRawFiles([entry]);
  const mockGmail = createMockGmail(emails);
  const twilioMock = createTwilioMock('success');
  const statePath = tmpStatePath();

  const llmCaller = logLLM
    ? async (opts) => {
        const res = await callLLM(opts);
        console.log(
          '[LLM DEBUG]',
          opts.emailObj?.message_id,
          'notify=',
          res.parsed?.notify,
          'urgency=',
          res.parsed?.message_packet?.urgency,
          'tokens=',
          res.tokens,
          'latency=',
          res.latencyMs,
          'content=',
          res.content
        );
        return res;
      }
    : undefined;

  const appRunner = await startApp({
    configOverrides: {
      port: 0,
      statePath,
      pollIntervalMs: 1000,
      pollMaxResults: 5,
      dryRun: true
    },
    gmailClient: mockGmail,
    twilioClient: twilioMock,
    llmCaller,
    startPolling: false,
    skipTwilioStartupCheck: true,
    startServer: false
  });

  try {
    await appRunner.pollNow();
    const decisions = appRunner.ctx.stateManager.getState().recent_decisions;
    const decision = decisions.find((d) => d.id === entry.id);
    assert.ok(decision, `decision missing for ${entry.id}`);
    assert.strictEqual(
      !!decision.notify,
      !!entry.expect_notify,
      `LLM notify mismatch for ${entry.id} (${entry.description})`
    );
  } finally {
    await appRunner.stop();
    await cleanupFile(statePath);
  }
};

for (const entry of fixtures.llmJudgment) {
  const subject = subjectFromRaw(entry.raw_file);
  test(
    `[Real LLM] ${subject} -> expect notify=${entry.expect_notify}`,
    { skip: !useRealLLM },
    async () => {
      await runCase(entry);
    }
  );
}
