import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { createGmailClient, listMessages, fetchRawMessage, parseRawEmail, gmailLinkFor } from './gmail.js';
import { callLLM, healthCheckLLM } from './llm.js';
import { trimEmailForLLM } from './email_trim.js';
import { createTwilioClient, sendSms, checkTwilioCredentials } from './twilio.js';
import { createStateManager } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...args) => console.log(new Date().toISOString(), ...args);

export const buildConfig = (env = process.env) => ({
  port: parseInt(env.PORT || '3000', 10),
  pollIntervalMs: parseInt(env.POLL_INTERVAL_MS || '15000', 10),
  pollMaxResults: parseInt(env.POLL_MAX_RESULTS || '25', 10),
  gmailQuery: env.GMAIL_QUERY || 'newer_than:7d',
  statePath: env.STATE_PATH || './data/state.json',
  maxProcessedIds: parseInt(env.MAX_PROCESSED_IDS || '50000', 10),
  recentLimit: parseInt(env.RECENT_LIMIT || '200', 10),
  maxSmsChars: parseInt(env.MAX_SMS_CHARS || '900', 10),
  maxConcurrency: parseInt(env.MAX_CONCURRENCY || '3', 10),
  llmBaseUrl: env.LLM_BASE_URL || 'http://127.0.0.1:8080',
  llmModel: env.LLM_MODEL || 'local-model',
  llmTemperature: parseFloat(env.LLM_TEMPERATURE || '0.2'),
  llmMaxOutputTokens: parseInt(env.LLM_MAX_OUTPUT_TOKENS || '300', 10),
  llmTimeoutMs: parseInt(env.LLM_TIMEOUT_MS || '120000', 10),
  maxEmailBodyChars: parseInt(env.MAX_EMAIL_BODY_CHARS || '4000', 10),
  dryRun: (env.DRY_RUN || 'false').toLowerCase() === 'true',
  llmApiKey: env.LLM_API_KEY || '',
  gmailClientId: env.GMAIL_CLIENT_ID,
  gmailClientSecret: env.GMAIL_CLIENT_SECRET,
  gmailRefreshToken: env.GMAIL_REFRESH_TOKEN,
  twilioAccountSid: env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: env.TWILIO_AUTH_TOKEN,
  twilioFrom: env.TWILIO_FROM,
  twilioTo: env.TWILIO_TO
});

const createLimiter = (maxConcurrency) => {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= maxConcurrency) return;
    const task = queue.shift();
    if (!task) return;
    running += 1;
    task()
      .catch((err) => log('Task error', err.message))
      .finally(() => {
        running -= 1;
        next();
      });
  };
  const schedule = (fn) =>
    new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (err) {
          reject(err);
        }
      });
      next();
    });
  return schedule;
};

const ensureStateDir = async (statePath) => {
  const dir = path.dirname(statePath);
  await fs.promises.mkdir(dir, { recursive: true });
};

const tokenCountFromDecision = (decision) => decision?.tokens || 0;

const processSingleMessage = async (ctx, messageMeta, state) => {
  const messageId = messageMeta.id;
  if (state.processed[messageId]) {
    return;
  }

  try {
    const raw = await fetchRawMessage(ctx.gmailClient, messageId);
    const parsed = await parseRawEmail(raw);
    const gmailLink = gmailLinkFor(parsed);
    const emailObj = {
      message_id: parsed.id,
      thread_id: parsed.threadId,
      gmail_link: gmailLink,
      date: parsed.date,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      body_text: parsed.body_text,
      attachments: parsed.attachments
    };

    const trimmedEmail = trimEmailForLLM(emailObj, { maxBodyChars: ctx.config.maxEmailBodyChars });

    ctx.stateManager.bumpLLMRequests();
    let decision;
    try {
      const llmRes = await ctx.callLLM({
        llmBaseUrl: ctx.config.llmBaseUrl,
        apiKey: ctx.config.llmApiKey,
        model: ctx.config.llmModel,
        temperature: ctx.config.llmTemperature,
        maxOutputTokens: ctx.config.llmMaxOutputTokens,
        timeoutMs: ctx.config.llmTimeoutMs,
        emailObj: trimmedEmail,
        maxSmsChars: ctx.config.maxSmsChars
      });
      ctx.stateManager.addTokenEvent(llmRes.tokens);
      ctx.stateManager.setLLMOk(llmRes.latencyMs);
      decision = {
        id: messageId,
        notify: !!llmRes.parsed.notify,
        message_packet: llmRes.parsed.message_packet,
        confidence: llmRes.parsed.confidence,
        reason: llmRes.parsed.reason,
        tokens: llmRes.tokens,
        llm_latency_ms: llmRes.latencyMs,
        gmail_link: gmailLink,
        from: parsed.from,
        subject: parsed.subject,
        trim_stats: trimmedEmail.stats,
        decided_at: Date.now()
      };
    } catch (err) {
      ctx.stateManager.setLLMError(err.message);
      decision = {
        id: messageId,
        notify: false,
        message_packet: { title: 'LLM error', body: err.message, urgency: 'normal' },
        confidence: 0,
        reason: `LLM failure: ${err.message}`,
        tokens: 0,
        llm_latency_ms: 0,
        gmail_link: gmailLink,
        from: parsed.from,
        subject: parsed.subject,
        trim_stats: trimmedEmail.stats,
        decided_at: Date.now()
      };
    }

    ctx.stateManager.addDecision(decision);
    const shouldNotify = !!decision.notify;

    if (shouldNotify) {
      const packet = decision.message_packet || {};
      let smsBody = `${packet.title || 'New mail'}`;
      if (packet.urgency) smsBody += ` [${packet.urgency}]`;
      if (packet.body) smsBody += `\n${packet.body}`;
      const truncated = smsBody.slice(0, ctx.config.maxSmsChars);
      try {
        const sendResult = await sendSms({
          client: ctx.twilioClient,
          to: ctx.config.twilioTo,
          from: ctx.config.twilioFrom,
          body: truncated,
          dryRun: ctx.config.dryRun
        });
        ctx.stateManager.setTwilioOk();
        ctx.stateManager.addSend({
          sent_at: Date.now(),
          from: parsed.from,
          subject: parsed.subject,
          urgency: packet.urgency || 'normal',
          tokens_for_email: tokenCountFromDecision(decision),
          twilio_sid: sendResult.sid,
          sms_preview: truncated,
          gmail_link: gmailLink
        });
      } catch (err) {
        ctx.stateManager.setTwilioError(err.message);
        log('Twilio send failed', err.message);
      }
    }

    ctx.stateManager.markProcessed(
      messageId,
      decision.reason?.startsWith('LLM failure') ? 'error' : 'ok',
      decision.reason || ''
    );
  } catch (err) {
    log('Processing message failed', messageId, err.message);
    ctx.stateManager.markProcessed(messageId, 'error', err.message);
  }
};

const pollGmail = async (ctx) => {
  if (ctx.pollLock) return;
  ctx.pollLock = true;
  const state = ctx.stateManager.getState();
  ctx.stateManager.recordGmailPoll();
  try {
    const messages = await listMessages(ctx.gmailClient, {
      maxResults: ctx.config.pollMaxResults,
      query: ctx.config.gmailQuery
    });
    ctx.stateManager.setGmailOk();
    const newMessages = messages.filter((m) => !state.processed[m.id]);
    if (newMessages.length) {
      log(`Found ${newMessages.length} new messages`);
    }
    const tasks = newMessages.map((m) => ctx.limiter(() => processSingleMessage(ctx, m, state)));
    await Promise.allSettled(tasks);
  } catch (err) {
    ctx.stateManager.setGmailError(err.message);
    log('Gmail poll failed', err.message);
  } finally {
    await ctx.stateManager.save();
    ctx.pollLock = false;
  }
};

const maybeCheckLLMHealth = async (ctx) => {
  const stats = ctx.stateManager.getState().stats;
  const now = Date.now();
  const lastOk = stats.llm.last_ok_at || 0;
  const age = now - lastOk;
  if (age < 5 * 60 * 1000) return;
  const res = await ctx.llmHealthCheck({
    llmBaseUrl: ctx.config.llmBaseUrl,
    apiKey: ctx.config.llmApiKey,
    timeoutMs: Math.min(ctx.config.llmTimeoutMs, 10000)
  });
  ctx.stateManager.setLLMHealthCheck(res.ok, res.latencyMs, res.error);
  await ctx.stateManager.save();
};

const startPolling = (ctx) => {
  const loop = async () => {
    await pollGmail(ctx);
    await maybeCheckLLMHealth(ctx);
    ctx.pollTimer = setTimeout(loop, ctx.config.pollIntervalMs);
  };
  ctx.pollTimer = setTimeout(loop, 1000);
};

const stopPolling = (ctx) => {
  if (ctx.pollTimer) clearTimeout(ctx.pollTimer);
  ctx.pollTimer = null;
};

const twilioStartupCheck = async (ctx) => {
  if (!ctx.twilioClient) {
    ctx.stateManager.setTwilioError('Missing Twilio credentials');
    return;
  }
  const res = await checkTwilioCredentials(ctx.twilioClient, ctx.config.twilioAccountSid);
  if (res.ok) {
    ctx.stateManager.setTwilioOk();
  } else {
    ctx.stateManager.setTwilioError(res.error || 'Twilio check failed');
  }
  await ctx.stateManager.save();
};

const buildHealth = (ctx, stats) => {
  const now = Date.now();
  const gmailOk =
    stats.gmail.last_ok_at > 0 && now - stats.gmail.last_ok_at <= ctx.config.pollIntervalMs * 2 && !stats.gmail.last_error;
  const llmRecent = stats.llm.last_ok_at > 0 && now - stats.llm.last_ok_at <= 5 * 60 * 1000;
  const llmOk = (llmRecent || stats.llm.last_health_check_at) && !stats.llm.last_error;
  const twilioRecent = stats.twilio.last_ok_at > 0 && now - stats.twilio.last_ok_at <= 24 * 60 * 60 * 1000;
  const twilioOk = (twilioRecent || stats.twilio.startup_ok_at) && !stats.twilio.last_error;
  return {
    gmail: {
      ok: gmailOk,
      last_success_at: stats.gmail.last_ok_at,
      last_error: stats.gmail.last_error,
      last_poll_at: stats.gmail.last_poll_at
    },
    llm: {
      ok: llmOk,
      last_success_at: stats.llm.last_ok_at,
      last_error: stats.llm.last_error,
      avg_latency_ms: stats.llm.avg_latency_ms,
      last_latency_ms: stats.llm.last_latency_ms
    },
    twilio: {
      ok: twilioOk,
      last_success_at: stats.twilio.last_ok_at || stats.twilio.startup_ok_at,
      last_error: stats.twilio.last_error
    }
  };
};

const buildStatusSnapshot = (ctx) => {
  const current = ctx.stateManager.getState();
  const stats = current.stats;
  const health = buildHealth(ctx, stats);
  return {
    health,
    stats,
    recent_sends: [...(current.recent_sends || [])].slice(-50).reverse(),
    recent_decisions: [...(current.recent_decisions || [])].slice(-20).reverse(),
    config_sanitized: {
      poll_interval_ms: ctx.config.pollIntervalMs,
      poll_max_results: ctx.config.pollMaxResults,
      gmail_query: ctx.config.gmailQuery,
      max_sms_chars: ctx.config.maxSmsChars,
      max_email_body_chars: ctx.config.maxEmailBodyChars,
      max_concurrency: ctx.config.maxConcurrency,
      dry_run: ctx.config.dryRun,
      llm_base_url: ctx.config.llmBaseUrl,
      llm_model: ctx.config.llmModel
    }
  };
};

const startServer = (ctx) => {
  const app = express();
  app.use(express.json());

  app.get('/api/status', (req, res) => {
    res.json(buildStatusSnapshot(ctx));
  });

  app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'dashboard.html');
    res.sendFile(filePath);
  });

  const server = app.listen(ctx.config.port, () => {
    log(`Server listening on port ${server.address().port}`);
  });

  return { app, server };
};

export const startApp = async (overrides = {}) => {
  const config = { ...buildConfig(), ...(overrides.configOverrides || {}) };

  const gmailClient =
    overrides.gmailClient ||
    createGmailClient({
      clientId: config.gmailClientId,
      clientSecret: config.gmailClientSecret,
      refreshToken: config.gmailRefreshToken
    });

  const twilioClient =
    overrides.twilioClient ||
    createTwilioClient({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken
    });

  const stateManager =
    overrides.stateManager ||
    createStateManager({
      statePath: config.statePath,
      maxProcessedIds: config.maxProcessedIds,
      recentLimit: config.recentLimit
    });

  const limiter = createLimiter(config.maxConcurrency);

  const ctx = {
    config,
    gmailClient,
    twilioClient,
    stateManager,
    limiter,
    callLLM: overrides.llmCaller || callLLM,
    llmHealthCheck: overrides.llmHealthChecker || healthCheckLLM,
    pollLock: false,
    pollTimer: null
  };

  await ensureStateDir(config.statePath);
  await stateManager.load();

  if (!overrides.skipTwilioStartupCheck) {
    await twilioStartupCheck(ctx);
  }

  let app = null;
  let server = null;
  if (overrides.startServer !== false) {
    const srv = startServer(ctx);
    app = srv.app;
    server = srv.server;
  }

  if (overrides.startPolling !== false) {
    startPolling(ctx);
  }

  return {
    app,
    server,
    ctx,
    stop: async () => {
      stopPolling(ctx);
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    },
    pollNow: () => pollGmail(ctx),
    getStatus: () => buildStatusSnapshot(ctx)
  };
};

if (process.env.NO_AUTO_START !== '1' && process.env.NODE_ENV !== 'test') {
  startApp().catch((err) => {
    log('Fatal error', err);
    process.exit(1);
  });
}
