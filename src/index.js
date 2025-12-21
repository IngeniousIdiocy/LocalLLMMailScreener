import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import axios from 'axios';

import { createGmailClient, listMessages, fetchRawMessage, parseRawEmail, gmailLinkFor } from './gmail.js';
import { callLLM, healthCheckLLM } from './llm.js';
import { trimEmailForLLM } from './email_trim.js';
import { createTwilioClient, sendSms, checkTwilioCredentials } from './twilio.js';
import { sendPushover, checkPushoverCredentials } from './pushover.js';
import { createStateManager } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...args) => {
  const tz = process.env.LOG_TIMEZONE || 'UTC';
  const ts = new Date().toLocaleString('en-CA', {
    timeZone: tz,
    hour12: false
  }).replace(', ', 'T');
  console.log(ts, ...args);
};
const fmtVal = (v) => {
  if (v === undefined || v === null) return '-';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const str = String(v).replace(/"/g, "'");
  return /\s/.test(str) ? `"${str}"` : str;
};
const logEvent = (tag, fields = {}) => {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmtVal(v)}`);
  log(`[${tag}]`, parts.join(' '));
};

const buildGmailQuery = (baseQuery, afterMs) => {
  const trimmed = (baseQuery || '').trim();
  const query = trimmed.length ? trimmed : 'newer_than:1d';
  const afterSeconds = afterMs ? Math.floor(afterMs / 1000) : 0;
  if (afterSeconds) {
    return `${query} after:${afterSeconds}`;
  }
  return query;
};

export const buildConfig = (env = process.env) => ({
  port: parseInt(env.PORT || '3000', 10),
  pollIntervalMs: parseInt(env.POLL_INTERVAL_MS || '15000', 10),
  pollGraceMs: parseInt(env.POLL_GRACE_MS || '5000', 10),
  pollWindowMs: env.POLL_WINDOW_MS ? parseInt(env.POLL_WINDOW_MS, 10) : null,
  gmailSummaryIntervalMin: parseInt(env.GMAIL_SUMMARY_INTERVAL_MIN || '15', 10),
  pollMaxResults: parseInt(env.POLL_MAX_RESULTS || '25', 10),
  gmailQuery: env.GMAIL_QUERY || 'newer_than:1d',
  statePath: env.STATE_PATH || './data/state.json',
  maxProcessedIds: parseInt(env.MAX_PROCESSED_IDS || '50000', 10),
  recentLimit: parseInt(env.RECENT_LIMIT || '5000', 10),
  maxSmsChars: parseInt(env.MAX_SMS_CHARS || '900', 10),
  maxLlmConcurrency: parseInt(env.MAX_LLM_CONCURRENCY || env.MAX_CONCURRENCY || '3', 10),
  maxLlmQueue: parseInt(env.MAX_LLM_QUEUE || '20', 10),
  llmBaseUrl: env.LLM_BASE_URL || 'http://127.0.0.1:8080',
  llmModel: env.LLM_MODEL || 'local-model',
  llmTemperature: parseFloat(env.LLM_TEMPERATURE || '0.2'),
  llmMaxOutputTokens: parseInt(env.LLM_MAX_OUTPUT_TOKENS || '300', 10),
  llmTimeoutMs: parseInt(env.LLM_TIMEOUT_MS || '120000', 10),
  systemPromptPath: env.SYSTEM_PROMPT_PATH || './data/system_prompt.txt',
  maxEmailBodyChars: parseInt(env.MAX_EMAIL_BODY_CHARS || '4000', 10),
  dryRun: (env.DRY_RUN || 'false').toLowerCase() === 'true',
  notificationService: (env.NOTIFICATION_SERVICE || 'twilio').toLowerCase(),
  logDashboardRequests: (env.LOG_DASHBOARD_REQUESTS || 'false').toLowerCase() === 'true',
  llmApiKey: env.LLM_API_KEY || '',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  anthropicModelOpus: env.ANTHROPIC_MODEL_OPUS || 'claude-3-opus-20240229',
  anthropicModelSonnet: env.ANTHROPIC_MODEL_SONNET || 'claude-3-5-sonnet-20241022',
  analystMaxItemsOpus: parseInt(env.ANALYST_MAX_ITEMS_OPUS || '200', 10),
  analystMaxItemsSonnet: parseInt(env.ANALYST_MAX_ITEMS_SONNET || '1000', 10),
  analystMaxOutputTokens: parseInt(env.ANALYST_MAX_OUTPUT_TOKENS || '1200', 10),
  analystTimeoutMs: parseInt(env.ANALYST_TIMEOUT_MS || '60000', 10),
  gmailClientId: env.GMAIL_CLIENT_ID,
  gmailClientSecret: env.GMAIL_CLIENT_SECRET,
  gmailRefreshToken: env.GMAIL_REFRESH_TOKEN,
  twilioAccountSid: env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: env.TWILIO_AUTH_TOKEN,
  twilioFrom: env.TWILIO_FROM,
  twilioTo: env.TWILIO_TO,
  pushoverToken: env.PUSHOVER_TOKEN || env.PUSHOVER_API_TOKEN,
  pushoverUser: env.PUSHOVER_USER,
  pushoverDevice: env.PUSHOVER_DEVICE,
  logTimezone: env.LOG_TIMEZONE || 'UTC'
});

const createGmailSummaryTracker = (intervalMinRaw) => {
  const intervalMin = Math.max(0, Math.floor(Number.isFinite(intervalMinRaw) ? intervalMinRaw : 15));
  const intervalMs = intervalMin > 0 ? intervalMin * 60 * 1000 : 0;
  return {
    intervalMin,
    intervalMs,
    windowStart: null,
    pollOk: 0,
    pollBad: 0,
    newMail: 0
  };
};

const resetGmailSummaryWindow = (tracker, now) => {
  tracker.windowStart = now;
  tracker.pollOk = 0;
  tracker.pollBad = 0;
  tracker.newMail = 0;
};

const logGmailSummary = (ctx) => {
  const tracker = ctx.gmailSummary;
  if (!tracker) return;
  const metrics = [`poll_ok:${tracker.pollOk}`, `poll_bad:${tracker.pollBad}`, `new_mail:${tracker.newMail}`].join(' ');
  log('Summary [GMAIL]', `Summary of Activity for last ${tracker.intervalMin}m - ${metrics}`);
};

const recordGmailSummary = (ctx, { ok, newMail = 0 }) => {
  const tracker = ctx.gmailSummary;
  if (!tracker || tracker.intervalMs <= 0) return;

  tracker.pollOk += ok ? 1 : 0;
  tracker.pollBad += ok ? 0 : 1;
  const newMailCount = Number.isFinite(newMail) ? newMail : 0;
  tracker.newMail += Math.max(0, newMailCount);

  const now = Date.now();
  const isFirstWindow = tracker.windowStart === null;
  if (isFirstWindow) {
    tracker.windowStart = now;
  }
  if (isFirstWindow || now - tracker.windowStart >= tracker.intervalMs) {
    logGmailSummary(ctx);
    resetGmailSummaryWindow(tracker, now);
  }
};

const createLlmQueue = ({ maxConcurrency, maxQueue, processFn, onDrop, onStats }) => {
  const pending = [];
  const pendingIds = new Set();
  const runningIds = new Set();
  let droppedTotal = 0;
  let lastDroppedAt = 0;
  const idleResolvers = [];

  const depth = () => pending.length + runningIds.size;
  const publishStats = () =>
    onStats?.({
      depth: depth(),
      pending: pending.length,
      running: runningIds.size,
      dropped_total: droppedTotal,
      last_dropped_at: lastDroppedAt,
      max_queue: maxQueue
    });

  const notifyIdle = () => {
    if (pending.length === 0 && runningIds.size === 0) {
      while (idleResolvers.length) {
        const resolve = idleResolvers.shift();
        resolve();
      }
    }
  };

  const dropOldest = () => {
    const dropped = pending.shift();
    if (!dropped) return null;
    if (dropped.id) pendingIds.delete(dropped.id);
    droppedTotal += 1;
    lastDroppedAt = Date.now();
    onDrop?.(dropped);
    logEvent('LLM_QUEUE', { event: 'drop', id: dropped.id, depth: depth(), max: maxQueue });
    publishStats();
    notifyIdle();
    return dropped;
  };

  const enforceCapacity = () => {
    while (maxQueue > 0 && depth() > maxQueue && pending.length) {
      dropOldest();
    }
  };

  const pump = () => {
    publishStats();
    notifyIdle();
    while (runningIds.size < maxConcurrency && pending.length) {
      const task = pending.shift();
      if (task.id) pendingIds.delete(task.id);
      const key = task.id || Symbol('llm-task');
      runningIds.add(key);
      publishStats();
      Promise.resolve()
        .then(() => processFn(task))
        .catch((err) => logEvent('TASK', { event: 'error', error: err.message }))
        .finally(() => {
          runningIds.delete(key);
          publishStats();
          notifyIdle();
          pump();
        });
    }
  };

  const enqueue = (task) => {
    const id = task.id;
    if (id && (pendingIds.has(id) || runningIds.has(id))) {
      return { enqueued: false, reason: 'duplicate' };
    }
    pending.push(task);
    if (id) pendingIds.add(id);
    enforceCapacity();
    pump();
    return { enqueued: true };
  };

  return {
    enqueue,
    stats: () => ({
      depth: depth(),
      pending: pending.length,
      running: runningIds.size,
      dropped_total: droppedTotal,
      last_dropped_at: lastDroppedAt,
      max_queue: maxQueue
    }),
    whenIdle: () => {
      if (pending.length === 0 && runningIds.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    }
  };
};

const ensureStateDir = async (statePath) => {
  const dir = path.dirname(statePath);
  await fs.promises.mkdir(dir, { recursive: true });
};

const clampNumber = (val, min, max, fallback) => {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const deriveFeatureFlags = (trimmedEmail = {}) => {
  const url = trimmedEmail.url_analysis || {};
  const attachments = Array.isArray(trimmedEmail.attachments) ? trimmedEmail.attachments : [];
  const stats = trimmedEmail.stats || {};
  return {
    has_attachments: attachments.length > 0,
    attachment_count: attachments.length,
    has_urls: (url.count || 0) > 0,
    has_ip_based_urls: !!url.has_ip_based_urls,
    has_mismatched_urls: !!url.has_mismatched_urls,
    removed_sections: stats.removed_sections || [],
    trimmed_chars: stats.trimmed_char_count || 0,
    original_chars: stats.original_char_count || 0
  };
};

const buildAnalysisFields = (trimmedEmail = {}) => {
  const url = trimmedEmail.url_analysis || {};
  const sender = trimmedEmail.sender_analysis || {};
  const stats = trimmedEmail.stats || {};
  return {
    body_text: trimmedEmail.body_text || '',
    body_excerpt: trimmedEmail.body_excerpt,
    body_tail: trimmedEmail.body_tail,
    attachments: trimmedEmail.attachments || [],
    url_analysis: {
      count: url.count || 0,
      unique_domains: url.unique_domains || [],
      has_ip_based_urls: !!url.has_ip_based_urls,
      has_mismatched_urls: !!url.has_mismatched_urls
    },
    sender_analysis: sender,
    removed_sections: stats.removed_sections || [],
    token_estimate: stats.token_estimate || 0
  };
};

const domainFromEmail = (email = '') => {
  const match = String(email).match(/@([^>]+)>?$/);
  if (match && match[1]) return match[1].toLowerCase();
  const simple = String(email).split('@')[1];
  return simple ? simple.toLowerCase() : '';
};

const tokenCountFromDecision = (decision) => decision?.tokens || 0;
const computeRecentTps = (decisions, limit = 5) => {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { avg_tps: 0, samples: 0 };
  }
  const latest = decisions.slice(-limit);
  const samples = latest
    .map((d) => {
      const tokens = d.tokens || 0;
      const latencyMs = d.llm_latency_ms || 0;
      if (!latencyMs) return null;
      const tps = tokens / (latencyMs / 1000);
      return Number.isFinite(tps) ? tps : null;
    })
    .filter((v) => v !== null);
  if (!samples.length) return { avg_tps: 0, samples: 0 };
  const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  return { avg_tps: Math.round(avg * 100) / 100, samples: samples.length };
};

const processSingleMessage = async (ctx, messageMeta) => {
  const messageId = messageMeta.id;
  if (ctx.stateManager.getState().processed[messageId]) {
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
        maxSmsChars: ctx.config.maxSmsChars,
        systemPromptPath: ctx.config.systemPromptPath
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
        feature_flags: deriveFeatureFlags(trimmedEmail),
        analysis: buildAnalysisFields(trimmedEmail),
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
        feature_flags: deriveFeatureFlags(trimmedEmail),
        analysis: buildAnalysisFields(trimmedEmail),
        decided_at: Date.now()
      };
    }

  // Fire optional hook for immediate reporting (used by integration test logging).
  if (ctx.onDecision) {
    try {
      ctx.onDecision(decision);
    } catch (err) {
      log('onDecision hook error', err.message);
    }
  }

    logEvent('LLM_DECISION', {
      notify: decision.notify ? 'yes' : 'no',
      from: decision.from,
      subject: decision.subject,
      reason: decision.reason,
      tokens: decision.tokens,
      latency_ms: decision.llm_latency_ms
    });

    ctx.stateManager.addDecision(decision);
    const shouldNotify = !!decision.notify;

    if (shouldNotify) {
      const packet = decision.message_packet || {};
      let smsBody = `${packet.title || 'New mail'}`;
      if (packet.urgency) smsBody += ` [${packet.urgency}]`;
      if (packet.body) smsBody += `\n${packet.body}`;
      const truncated = smsBody.slice(0, ctx.config.maxSmsChars);
      const service = ctx.config.notificationService;
      if (service === 'twilio') {
        try {
          const sendResult = await sendSms({
            client: ctx.twilioClient,
            to: ctx.config.twilioTo,
            from: ctx.config.twilioFrom,
            body: truncated,
            dryRun: ctx.config.dryRun
          });
          ctx.stateManager.setTwilioOk();
          logEvent('TWILIO', {
            send: 'ok',
            to: ctx.config.twilioTo,
            from: parsed.from,
            subject: parsed.subject,
            urgency: packet.urgency || 'normal',
            sid: sendResult.sid
          });
          ctx.stateManager.addSend({
            sent_at: Date.now(),
            from: parsed.from,
            subject: parsed.subject,
            urgency: packet.urgency || 'normal',
            tokens_for_email: tokenCountFromDecision(decision),
            reason: decision.reason,
            twilio_sid: sendResult.sid,
            notification_provider: 'twilio',
            notification_id: sendResult.sid,
            sms_preview: truncated,
            gmail_link: gmailLink
          });
        } catch (err) {
          ctx.stateManager.setTwilioError(err.message);
          logEvent('TWILIO', {
            send: 'fail',
            to: ctx.config.twilioTo,
            from: parsed.from,
            subject: parsed.subject,
            urgency: packet.urgency || 'normal',
            error: err.message
          });
        }
      } else if (service === 'pushover') {
        try {
          const sendResult = await ctx.pushoverSender({
            token: ctx.config.pushoverToken,
            user: ctx.config.pushoverUser,
            device: ctx.config.pushoverDevice,
            title: packet.title || 'New mail',
            message: truncated,
            priority: 2,
            retry: 100,
            expire: 7 * 24 * 60 * 60,
            dryRun: ctx.config.dryRun
          });
          ctx.stateManager.setPushoverOk();
          logEvent('PUSHOVER', {
            send: 'ok',
            to: ctx.config.pushoverUser,
            device: ctx.config.pushoverDevice,
            from: parsed.from,
            subject: parsed.subject,
            urgency: packet.urgency || 'normal',
            receipt: sendResult.receipt
          });
          ctx.stateManager.addSend({
            sent_at: Date.now(),
            from: parsed.from,
            subject: parsed.subject,
            urgency: packet.urgency || 'normal',
            tokens_for_email: tokenCountFromDecision(decision),
            reason: decision.reason,
            pushover_receipt: sendResult.receipt,
            notification_provider: 'pushover',
            notification_id: sendResult.receipt,
            sms_preview: truncated,
            gmail_link: gmailLink
          });
        } catch (err) {
          ctx.stateManager.setPushoverError(err.message);
          logEvent('PUSHOVER', {
            send: 'fail',
            to: ctx.config.pushoverUser,
            device: ctx.config.pushoverDevice,
            from: parsed.from,
            subject: parsed.subject,
            urgency: packet.urgency || 'normal',
            error: err.message
          });
        }
      } else {
        const msg = `Notification service not recognized: ${service}`;
        ctx.stateManager.setTwilioError(msg);
        ctx.stateManager.setPushoverError(msg);
        logEvent('NOTIFY', { send: 'fail', error: msg });
      }
    }

    ctx.stateManager.markProcessed(
      messageId,
      decision.reason?.startsWith('LLM failure') ? 'error' : 'ok',
      decision.reason || ''
    );
    await ctx.stateManager.save();
  } catch (err) {
    logEvent('PROCESS', { id: messageId, status: 'fail', error: err.message });
    ctx.stateManager.markProcessed(messageId, 'error', err.message);
    await ctx.stateManager.save();
  }
};

const pollGmail = async (ctx) => {
  if (ctx.pollLock) return;
  ctx.pollLock = true;
  const state = ctx.stateManager.getState();
  const previousPollAt = state.stats.gmail.last_poll_at || 0;
  const now = Date.now();
  const windowMs = ctx.config.pollWindowMs ?? ctx.config.pollIntervalMs;
  const graceMs = Math.max(ctx.config.pollGraceMs || 0, 0);
  const windowStartMs = windowMs > 0 ? Math.max(0, now - windowMs - graceMs) : 0;
  const effectiveQuery = buildGmailQuery(ctx.config.gmailQuery, windowStartMs);
  ctx.stateManager.recordGmailPoll();
  const shouldLogPerPoll = !ctx.gmailSummary || ctx.gmailSummary.intervalMs <= 0;
  try {
    const effectiveMaxResults = ctx.config.pollMaxResults;
    const messages = await listMessages(ctx.gmailClient, {
      maxResults: effectiveMaxResults,
      query: effectiveQuery
    });
    ctx.stateManager.setGmailOk();
    const newMessages = messages.filter((m) => !state.processed[m.id]);
    if (shouldLogPerPoll) {
      logEvent('GMAIL', {
        poll: 'ok',
        new: newMessages.length,
        max_results: effectiveMaxResults,
        query: effectiveQuery,
        window_ms: ctx.config.pollWindowMs ?? ctx.config.pollIntervalMs,
        grace_ms: ctx.config.pollGraceMs
      });
    }
    recordGmailSummary(ctx, { ok: true, newMail: newMessages.length });
    for (const m of newMessages) {
      ctx.llmQueue.enqueue({ id: m.id, messageMeta: m });
    }
  } catch (err) {
    ctx.stateManager.revertGmailPoll(previousPollAt);
    ctx.stateManager.setGmailError(err.message);
    logEvent('GMAIL', { poll: 'fail', error: err.message });
    recordGmailSummary(ctx, { ok: false, newMail: 0 });
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

const pushoverStartupCheck = async (ctx) => {
  const res = await ctx.pushoverValidator({
    token: ctx.config.pushoverToken,
    user: ctx.config.pushoverUser,
    device: ctx.config.pushoverDevice
  });
  if (res.ok) {
    ctx.stateManager.setPushoverOk();
  } else {
    ctx.stateManager.setPushoverError(res.error || 'Pushover check failed');
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
  const pushoverRecent =
    stats.pushover.last_ok_at > 0 && now - stats.pushover.last_ok_at <= 24 * 60 * 60 * 1000;
  const pushoverOk = (pushoverRecent || stats.pushover.startup_ok_at) && !stats.pushover.last_error;

  const notificationService = ctx.config.notificationService;
  const notificationStats = notificationService === 'pushover' ? stats.pushover : stats.twilio;
  const notificationOk = notificationService === 'pushover' ? pushoverOk : twilioOk;

  const health = {
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
    notification: {
      service: notificationService,
      ok: notificationOk,
      last_success_at: notificationStats.last_ok_at || notificationStats.startup_ok_at,
      last_error: notificationStats.last_error
    }
  };

  if (notificationService === 'twilio') {
    health.twilio = health.notification;
  } else if (notificationService === 'pushover') {
    health.pushover = health.notification;
  }

  return health;
};

const buildStatusSnapshot = (ctx) => {
  const current = ctx.stateManager.getState();
  const stats = current.stats;
  const health = buildHealth(ctx, stats);
  const llmTps = computeRecentTps(current.recent_decisions || []);
  const statsWithDerived = { ...stats, llm_tps: llmTps };
  return {
    health,
    stats: statsWithDerived,
    recent_sends: [...(current.recent_sends || [])].slice(-50).reverse(),
    recent_decisions: [...(current.recent_decisions || [])].slice(-20).reverse(),
    config_sanitized: {
      poll_interval_ms: ctx.config.pollIntervalMs,
      poll_max_results: ctx.config.pollMaxResults,
      poll_grace_ms: ctx.config.pollGraceMs,
      poll_window_ms: ctx.config.pollWindowMs ?? ctx.config.pollIntervalMs,
      gmail_query: ctx.config.gmailQuery,
      gmail_summary_interval_min: ctx.gmailSummary?.intervalMin ?? ctx.config.gmailSummaryIntervalMin,
      max_sms_chars: ctx.config.maxSmsChars,
      max_email_body_chars: ctx.config.maxEmailBodyChars,
      max_llm_concurrency: ctx.config.maxLlmConcurrency,
      max_llm_queue: ctx.config.maxLlmQueue,
      dry_run: ctx.config.dryRun,
      notification_service: ctx.config.notificationService,
      llm_base_url: ctx.config.llmBaseUrl,
      llm_model: ctx.config.llmModel,
      analyst_max_items_opus: ctx.config.analystMaxItemsOpus,
      analyst_max_items_sonnet: ctx.config.analystMaxItemsSonnet,
      analyst_max_output_tokens: ctx.config.analystMaxOutputTokens,
      analyst_timeout_ms: ctx.config.analystTimeoutMs
    }
  };
};

const parseTimeWindowHours = (query) => {
  const hoursRaw = query.hours ? Number(query.hours) : null;
  const daysRaw = query.days ? Number(query.days) : null;
  const totalHours = (Number.isFinite(hoursRaw) ? hoursRaw : 0) + (Number.isFinite(daysRaw) ? daysRaw * 24 : 0);
  if (totalHours > 0) return Math.max(1, Math.min(totalHours, 24 * 60));
  return 24; // default
};

const parseFilterStrings = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
};

const parseBooleanQuery = (val) => {
  if (val === undefined) return null;
  const str = String(val).toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(str)) return true;
  if (['0', 'false', 'no', 'n'].includes(str)) return false;
  return null;
};

const filterRefusals = (decisions = [], filters = {}) => {
  const hours = parseTimeWindowHours(filters);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const minConf = filters.min_confidence != null ? Number(filters.min_confidence) : null;
  const maxConf = filters.max_confidence != null ? Number(filters.max_confidence) : null;
  const reasonIncludes = (filters.reason_includes || '').toLowerCase();
  const subjectIncludes = (filters.subject_includes || '').toLowerCase();
  const fromIncludes = (filters.from_includes || '').toLowerCase();
  const domainIncludes = (filters.domain_includes || '').toLowerCase();
  const removedSections = parseFilterStrings(filters.removed_section);
  const hasAttachments = parseBooleanQuery(filters.has_attachments);
  const hasUrls = parseBooleanQuery(filters.has_urls);
  const hasIpUrls = parseBooleanQuery(filters.has_ip_based_urls);
  const hasMismatch = parseBooleanQuery(filters.has_mismatched_urls);

  return decisions.filter((d) => {
    if (d.notify) return false;
    const ts = d.decided_at || 0;
    if (ts < since) return false;
    if (Number.isFinite(minConf) && (d.confidence ?? 0) < minConf) return false;
    if (Number.isFinite(maxConf) && (d.confidence ?? 0) > maxConf) return false;
    const feature = d.feature_flags || {};
    if (hasAttachments !== null && !!feature.has_attachments !== hasAttachments) return false;
    if (hasUrls !== null && !!feature.has_urls !== hasUrls) return false;
    if (hasIpUrls !== null && !!feature.has_ip_based_urls !== hasIpUrls) return false;
    if (hasMismatch !== null && !!feature.has_mismatched_urls !== hasMismatch) return false;
    if (removedSections.length) {
      const present = (feature.removed_sections || []).map((s) => String(s).toLowerCase());
      const hasAny = removedSections.some((r) => present.includes(r));
      if (!hasAny) return false;
    }
    const reason = (d.reason || '').toLowerCase();
    const subject = (d.subject || '').toLowerCase();
    const from = (d.from || '').toLowerCase();
    const domain = domainFromEmail(d.from);
    if (reasonIncludes && !reason.includes(reasonIncludes)) return false;
    if (subjectIncludes && !subject.includes(subjectIncludes)) return false;
    if (fromIncludes && !from.includes(fromIncludes)) return false;
    if (domainIncludes && !domain.includes(domainIncludes)) return false;
    return true;
  });
};

const bucketRefusals = (decisions = [], hours) => {
  const useDaily = hours > 48;
  const buckets = new Map();
  decisions.forEach((d) => {
    const ts = d.decided_at || 0;
    if (!ts) return;
    const date = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const key = useDaily
      ? `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
      : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
          date.getUTCHours()
        )}:00`;
    const entry = buckets.get(key) || { label: key, count: 0 };
    entry.count += 1;
    buckets.set(key, entry);
  });
  return Array.from(buckets.values()).sort((a, b) => (a.label < b.label ? -1 : 1));
};

const topCounts = (items, keyFn, limit = 10) => {
  const counts = new Map();
  items.forEach((d) => {
    const key = keyFn(d);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
};

const summarizeDecision = (d) => ({
  id: d.id,
  from: d.from,
  subject: d.subject,
  reason: d.reason,
  confidence: d.confidence,
  decided_at: d.decided_at,
  gmail_link: d.gmail_link,
  feature_flags: d.feature_flags || {}
});

const buildRefusalAnalytics = (decisions, filters = {}) => {
  const hours = parseTimeWindowHours(filters);
  const filtered = filterRefusals(decisions, { ...filters, hours });
  const latestLimit = clampNumber(filters.limit, 1, 500, 100);
  return {
    total: filtered.length,
    window_hours: hours,
    buckets: bucketRefusals(filtered, hours),
    top_reasons: topCounts(filtered, (d) => (d.reason || '').slice(0, 120)),
    top_senders: topCounts(filtered, (d) => (d.from || '').toLowerCase()),
    top_domains: topCounts(filtered, (d) => domainFromEmail(d.from)),
    latest: filtered.slice(-latestLimit).reverse().map(summarizeDecision)
  };
};

const selectAnalysisCases = (decisions = [], filters = {}, modelCaps = {}) => {
  const hours = parseTimeWindowHours(filters);
  const filtered = filterRefusals(decisions, { ...filters, hours });
  const maxItems = modelCaps.maxItems || filtered.length;
  const trimmed = filtered.slice(-maxItems);
  return { hours, selected: trimmed };
};

const buildClaudePrompt = ({ cases = [], windowHours, filtersSummary }) => {
  const header = `You are reviewing emails that were previously marked notify=false by a local model. Identify borderline or likely misclassified cases that should have been notify=true.`;
  const filterLine = filtersSummary ? `Filters: ${filtersSummary}` : '';
  const body = cases
    .map((c, idx) => {
      const features = c.feature_flags || {};
      const url = (c.analysis?.url_analysis || {});
      const attachments = c.analysis?.attachments || [];
      const lines = [
        `Case ${idx + 1}:`,
        `From: ${c.from || 'unknown'}`,
        `Subject: ${c.subject || '—'}`,
        `Reason: ${c.reason || '—'}`,
        `Confidence: ${c.confidence ?? 'n/a'}`,
        `Decided at: ${new Date(c.decided_at || 0).toISOString()}`,
        `Features: attachments=${attachments.length}, urls=${url.count || 0}, ip_urls=${url.has_ip_based_urls ? 'yes' : 'no'}, mismatched_urls=${url.has_mismatched_urls ? 'yes' : 'no'}, removed_sections=${(features.removed_sections || []).join('|')}`,
        `Body (trimmed): ${c.analysis?.body_text || ''}`
      ];
      return lines.join('\n');
    })
    .join('\n\n');
  const ask = `For the above cases (last ${windowHours}h), return:
- borderline_cases: list of case numbers where notify=true is plausible, with a 1-2 line rationale
- obvious_notify_true: any case numbers that clearly should be notify=true
- patterns: concise patterns you see in refusals
- next_rules: 2-4 precise prompt/rule tweaks to reduce false refusals without weakening phishing handling`;
  return [header, filterLine, body, ask].filter(Boolean).join('\n\n');
};

const startServer = (ctx) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const isDashboardPath = req.path === '/' || req.path.startsWith('/api');
    if (isDashboardPath && !ctx.dashboardFirstLogged) {
      ctx.dashboardFirstLogged = true;
      logEvent('DASHBOARD', { event: 'first_hit', path: req.path, method: req.method });
    }
    if (ctx.config.logDashboardRequests && isDashboardPath) {
      logEvent('DASHBOARD', { path: req.path, method: req.method });
    }
    next();
  });

  app.get('/api/status', (req, res) => {
    res.json(buildStatusSnapshot(ctx));
  });

  app.get('/api/analytics/refusals', (req, res) => {
    const current = ctx.stateManager.getState();
    const decisions = current.recent_decisions || [];
    const analytics = buildRefusalAnalytics(decisions, req.query || {});
    res.json(analytics);
  });

  app.post('/api/analysis/claude', async (req, res) => {
    const apiKey = ctx.config.anthropicApiKey;
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: 'Missing Anthropic API key' });
    }
    const body = req.body || {};
    const modelChoice = String(body.model || 'sonnet').toLowerCase();
    const model =
      modelChoice === 'opus' ? ctx.config.anthropicModelOpus : ctx.config.anthropicModelSonnet;
    const maxItemsCap =
      modelChoice === 'opus' ? ctx.config.analystMaxItemsOpus : ctx.config.analystMaxItemsSonnet;
    const maxItems = clampNumber(body.max_items, 1, maxItemsCap, Math.min(200, maxItemsCap));
    const filters = { ...(body.filters || {}), hours: body.hours, days: body.days };
    const current = ctx.stateManager.getState();
    const decisions = current.recent_decisions || [];
    const { hours, selected } = selectAnalysisCases(decisions, filters, { maxItems });
    if (!selected.length) {
      return res.json({ ok: true, model, count: 0, result: 'No refusals matched the filters.' });
    }

    const filterSummaryParts = [];
    if (filters.reason_includes) filterSummaryParts.push(`reason~"${filters.reason_includes}"`);
    if (filters.subject_includes) filterSummaryParts.push(`subject~"${filters.subject_includes}"`);
    if (filters.from_includes) filterSummaryParts.push(`from~"${filters.from_includes}"`);
    if (filters.domain_includes) filterSummaryParts.push(`domain~"${filters.domain_includes}"`);
    if (filters.min_confidence != null) filterSummaryParts.push(`min_conf=${filters.min_confidence}`);
    if (filters.max_confidence != null) filterSummaryParts.push(`max_conf=${filters.max_confidence}`);
    if (filters.has_attachments != null) filterSummaryParts.push(`attachments=${filters.has_attachments}`);
    if (filters.has_urls != null) filterSummaryParts.push(`urls=${filters.has_urls}`);
    if (filters.has_ip_based_urls != null) filterSummaryParts.push(`ip_urls=${filters.has_ip_based_urls}`);
    if (filters.has_mismatched_urls != null) filterSummaryParts.push(`mismatch_urls=${filters.has_mismatched_urls}`);
    if (filters.removed_section) filterSummaryParts.push(`removed=${filters.removed_section}`);
    const filterSummary = filterSummaryParts.join(', ');

    const prompt = buildClaudePrompt({
      cases: selected,
      windowHours: hours,
      filtersSummary: filterSummary
    });

    const payload = {
      model,
      max_tokens: clampNumber(body.max_tokens, 200, 4000, ctx.config.analystMaxOutputTokens),
      temperature: clampNumber(body.temperature, 0, 1, 0),
      system:
        'You are a focused email triage auditor. Be concise, decisive, and prefer structured bullet summaries. Default to notify=true only when action/security/family/finance/operations are impacted.',
      messages: [{ role: 'user', content: prompt }]
    };

    try {
      const apiRes = await axios.post('https://api.anthropic.com/v1/messages', payload, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: ctx.config.analystTimeoutMs
      });
      const contentArr = apiRes.data?.content || [];
      const text = contentArr
        .map((c) => c.text)
        .filter(Boolean)
        .join('\n')
        .trim();
      res.json({
        ok: true,
        model,
        count: selected.length,
        window_hours: hours,
        filters: filters,
        result: text || '(empty response)'
      });
    } catch (err) {
      const apiMsg = err.response?.data?.error?.message || err.response?.data?.message;
      res.status(502).json({
        ok: false,
        error: apiMsg || err.message || 'Anthropic request failed'
      });
    }
  });

  app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'dashboard.html');
    res.sendFile(filePath);
  });

  const server = app.listen(ctx.config.port, () => {
    logEvent('SERVER', { listening: server.address().port });
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

  const pushoverSender = overrides.pushoverSender || sendPushover;
  const pushoverValidator = overrides.pushoverValidator || checkPushoverCredentials;

  const stateManager =
    overrides.stateManager ||
    createStateManager({
      statePath: config.statePath,
      maxProcessedIds: config.maxProcessedIds,
      recentLimit: config.recentLimit
    });

  const ctx = {
    config,
    gmailClient,
    twilioClient,
    pushoverSender,
    pushoverValidator,
    stateManager,
    llmQueue: null,
    callLLM: overrides.llmCaller || callLLM,
    llmHealthCheck: overrides.llmHealthChecker || healthCheckLLM,
    onDecision: overrides.onDecision,
    pollLock: false,
    pollTimer: null,
    gmailSummary: createGmailSummaryTracker(config.gmailSummaryIntervalMin),
    dashboardFirstLogged: false
  };

  const llmQueue = createLlmQueue({
    maxConcurrency: config.maxLlmConcurrency,
    maxQueue: config.maxLlmQueue,
    processFn: ({ messageMeta }) => processSingleMessage(ctx, messageMeta),
    onDrop: ({ id }) => {
      const reason = 'Dropped due to LLM queue overflow';
      ctx.stateManager.incrementLLMQueueDropped(id || '');
      if (id) ctx.stateManager.markProcessed(id, 'dropped', reason);
      ctx.stateManager.save().catch((err) => log('Queue drop save failed', err.message));
    },
    onStats: (stats) => ctx.stateManager.setLLMQueueStats(stats)
  });
  ctx.llmQueue = llmQueue;

  await ensureStateDir(config.statePath);
  await stateManager.load();
  ctx.stateManager.setLLMQueueStats(llmQueue.stats());

  if (!overrides.skipTwilioStartupCheck && config.notificationService === 'twilio') {
    await twilioStartupCheck(ctx);
  } else if (!overrides.skipTwilioStartupCheck && config.notificationService === 'pushover') {
    await pushoverStartupCheck(ctx);
  } else if (!overrides.skipTwilioStartupCheck) {
    const msg = `Notification service not recognized: ${config.notificationService}`;
    ctx.stateManager.setTwilioError(msg);
    ctx.stateManager.setPushoverError(msg);
    await ctx.stateManager.save();
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
    pollNow: async () => {
      await pollGmail(ctx);
      await ctx.llmQueue.whenIdle();
    },
    getStatus: () => buildStatusSnapshot(ctx)
  };
};

if (process.env.NO_AUTO_START !== '1' && process.env.NODE_ENV !== 'test') {
  startApp().catch((err) => {
    logEvent('FATAL', { error: err.message });
    process.exit(1);
  });
}
