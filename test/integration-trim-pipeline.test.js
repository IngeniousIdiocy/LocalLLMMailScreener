process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startApp } from '../src/index.js';
import {
  base64UrlEncode,
  makeRawEmail,
  createMockGmail,
  createTwilioMock,
  tmpStatePath,
  cleanupFile
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('llm receives trimmed email from gmail pipeline', async () => {
  const replyChainBody = readFixture('trim/reply_chain.txt');
  const rawEmail = makeRawEmail({
    from: 'a@example.com',
    to: 'b@example.com',
    subject: 'Trim Integration Check',
    body: replyChainBody,
    date: 'Mon, 01 Apr 2024 10:00:00 -0000'
  });
  const emails = [
    {
      id: 'm-trim-1',
      threadId: 't-trim-1',
      raw: base64UrlEncode(rawEmail)
    }
  ];

  const gmailMock = createMockGmail(emails);
  const twilioMock = createTwilioMock('success');
  const statePath = tmpStatePath();

  const captured = { emailObj: null };
  const llmCaller = async ({ emailObj }) => {
    captured.emailObj = emailObj;
    return {
      parsed: {
        notify: false,
        message_packet: { title: 'ok', body: 'ok', urgency: 'normal' },
        confidence: 0.5,
        reason: 'stub'
      },
      tokens: emailObj.body_text.length,
      latencyMs: 10,
      content: 'ok'
    };
  };

  const appRunner = await startApp({
    configOverrides: { port: 0, statePath, pollIntervalMs: 1000, dryRun: true },
    gmailClient: gmailMock,
    twilioClient: twilioMock,
    llmCaller,
    startPolling: false,
    skipTwilioStartupCheck: true,
    startServer: false
  });

  try {
    await appRunner.pollNow();
    assert.ok(captured.emailObj, 'LLM caller did not receive an email object');
    const { emailObj } = captured;

    assert.ok(emailObj.body_text.length < replyChainBody.length, 'body was not trimmed');
    assert.ok(!/-----Original Message-----/i.test(emailObj.body_text), 'reply header still present');
    assert.ok(!/^On .*wrote:$/im.test(emailObj.body_text), 'quoted reply marker still present');
    assert.ok(emailObj.stats?.removed_sections?.length, 'trim stats missing removed sections');
    assert.strictEqual(emailObj.headers.subject, 'Trim Integration Check');

    const decisions = appRunner.ctx.stateManager.getState().recent_decisions;
    const decision = decisions.find((d) => d.id === 'm-trim-1');
    assert.ok(decision?.trim_stats, 'decision missing trim stats');
    assert.strictEqual(decision.trim_stats.trimmed_char_count, emailObj.body_text.length);
  } finally {
    await appRunner.stop();
    await cleanupFile(statePath);
  }
});
