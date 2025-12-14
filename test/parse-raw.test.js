process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { parseRawEmail } from '../src/gmail.js';
import { base64UrlEncode } from './helpers.js';

const rawPath = (name) => path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'raw', name);

const buildGmailObj = (id, raw) => ({ id, threadId: `t-${id}`, raw });

test('parses plain text raw email into body_text', async () => {
  const raw = fs.readFileSync(rawPath('judge_urgent.eml'), 'utf8');
  const gmailObj = buildGmailObj('raw1', base64UrlEncode(raw));
  const parsed = await parseRawEmail(gmailObj);
  assert.match(parsed.body_text, /detected a \$4,320\.00 charge/i);
  assert.match(parsed.subject, /ACTION REQUIRED/i);
  assert.match(parsed.from, /Fraud Alert/);
});

test('parses HTML-only email and falls back to text conversion', async () => {
  const raw = fs.readFileSync(rawPath('html_newsletter.eml'), 'utf8');
  const gmailObj = buildGmailObj('raw2', base64UrlEncode(raw));
  const parsed = await parseRawEmail(gmailObj);
  assert.match(parsed.body_text, /HTML-only with no plain text part/i);
  assert.match(parsed.subject, /Monthly highlights/);
});
