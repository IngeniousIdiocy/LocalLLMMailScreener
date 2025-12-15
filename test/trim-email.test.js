process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { trimEmailForLLM } from '../src/email_trim.js';

const fixturePath = (name) => path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'trim', name);
const readFixture = (name) => fs.readFileSync(fixturePath(name), 'utf8');

const baseEmail = (body, overrides = {}) => ({
  message_id: 'mid-1',
  thread_id: 't-mid-1',
  gmail_link: 'https://mail.google.com',
  from: 'alice@example.com',
  to: 'bob@example.com',
  cc: '',
  subject: 'Test Subject',
  date: '2024-02-06T10:00:00.000Z',
  body_text: body,
  attachments: [],
  ...overrides
});

test('trims quoted reply chains and keeps newest message content', () => {
  const body = readFixture('reply_chain.txt');
  const trimmed = trimEmailForLLM(baseEmail(body), { maxBodyChars: 2000 });

  assert.match(trimmed.body_text, /Latest numbers look good/i);
  assert.ok(!trimmed.body_text.includes('Historical content'));
  assert.ok(!trimmed.body_text.includes('Old message line one'));
  assert.ok(trimmed.stats.original_char_count > trimmed.stats.trimmed_char_count);
  assert.ok(trimmed.stats.removed_sections.includes('reply_header'));
  assert.strictEqual(trimmed.headers.subject, 'Test Subject');
});

test('removes unsubscribe/footer noise from newsletters', () => {
  const body = readFixture('newsletter_unsubscribe.txt');
  const trimmed = trimEmailForLLM(baseEmail(body), { maxBodyChars: 2000 });

  assert.match(trimmed.body_text, /You're receiving this newsletter/);
  assert.ok(!/unsubscribe/i.test(trimmed.body_text));
  assert.ok(trimmed.stats.removed_sections.includes('unsubscribe_footer'));
});

test('handles HTML-converted text by normalizing whitespace and stripping browser prompts', () => {
  const body = readFixture('html_converted.txt');
  const trimmed = trimEmailForLLM(baseEmail(body), { maxBodyChars: 2000 });

  assert.match(trimmed.body_text, /HTML-only email converted to text/i);
  assert.ok(!/view this email in your browser/i.test(trimmed.body_text));
  assert.ok(!/manage preferences/i.test(trimmed.body_text));
  assert.ok(!/\n{3,}/.test(trimmed.body_text));
  assert.ok(trimmed.stats.removed_sections.includes('view_in_browser_footer'));
});

test('strips forwarded message headers to keep the latest note', () => {
  const body = readFixture('forwarded_message.txt');
  const trimmed = trimEmailForLLM(baseEmail(body), { maxBodyChars: 2000 });

  assert.match(trimmed.body_text, /please see the forwarded note below/i);
  assert.ok(!/Begin forwarded message/i.test(trimmed.body_text));
  assert.ok(!/Question about invoice/i.test(trimmed.body_text));
  assert.ok(trimmed.stats.removed_sections.includes('forwarded_message'));
});

test('enforces body length cap while preserving head and tail', () => {
  const longBody = `${'Intro line\n'.repeat(10)}${'middle content '.repeat(300)}Ending details.`;
  const trimmed = trimEmailForLLM(baseEmail(longBody), { maxBodyChars: 800 });

  assert.ok(trimmed.body_text.length <= 800);
  assert.ok(trimmed.body_text.includes('[... trimmed ...]'));
  assert.ok(trimmed.body_tail?.length > 0);
  assert.ok(trimmed.body_excerpt?.length > 0);
  assert.ok(trimmed.stats.removed_sections.includes('length_cap'));
});
