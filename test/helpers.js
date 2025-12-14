import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const readJsonFixture = (filename) => {
  const full = path.join(__dirname, 'fixtures', filename);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
};

export const fixtures = {
  emails: readJsonFixture('emails.json'),
  llm: readJsonFixture('llm_responses.json')
};

export const base64UrlEncode = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const makeRawEmail = ({ from, to, subject, body, date = 'Fri, 01 Mar 2024 10:00:00 -0000' }) =>
  [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    '',
    body
  ].join('\n');

export const buildEmails = (ids) => {
  const selected = fixtures.emails.filter((e) => ids.includes(e.id));
  return selected.map((e) => ({
    id: e.id,
    threadId: e.threadId || `t-${e.id}`,
    raw: base64UrlEncode(
      makeRawEmail({
        from: e.from,
        to: e.to,
        subject: e.subject,
        body: e.body,
        date: e.date
      })
    )
  }));
};

export const createMockGmail = (emails) => ({
  users: {
    messages: {
      list: async () => ({
        data: {
          messages: emails.map((e) => ({ id: e.id }))
        }
      }),
      get: async ({ id }) => {
        const email = emails.find((e) => e.id === id);
        if (!email) throw new Error('Not found');
        return {
          data: {
            id: email.id,
            threadId: email.threadId || `t-${id}`,
            raw: email.raw
          }
        };
      }
    }
  }
});

export const makeLLMStub = (responseMap) => ({
  caller: async ({ emailObj }) => {
    const scenario = responseMap[emailObj.message_id] || responseMap.default || {};
    if (scenario.responseType === 'invalid') {
      throw new Error('Invalid JSON from LLM: bad content');
    }
    if (scenario.responseType === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, scenario.delayMs || 500));
      throw new Error('timeout exceeded');
    }
    return {
      parsed: {
        notify: scenario.notify ?? false,
        message_packet: {
          title: scenario.title || 'Default title',
          body: scenario.body || 'Default body',
          urgency: scenario.urgency || 'normal'
        },
        confidence: scenario.confidence ?? 0.9,
        reason: scenario.reason || 'auto-decision'
      },
      tokens: scenario.tokens || 42,
      latencyMs: scenario.latencyMs || 50,
      content: 'ok'
    };
  },
  health: async () => ({ ok: true, latencyMs: 10 })
});

export const createTwilioMock = (behavior = 'success') => ({
  messages: {
    create: async () => {
      if (behavior === 'fail') throw new Error('twilio send failed');
      return { sid: 'SM123456789' };
    }
  },
  api: {
    accounts: () => ({
      fetch: async () => {
        if (behavior === 'credfail') throw new Error('twilio cred fail');
        return { sid: 'ACXXXXX' };
      }
    })
  }
});

export const tmpStatePath = () =>
  path.join(process.cwd(), 'data', `state-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

export const cleanupFile = async (filePath) => {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    /* ignore */
  }
};
