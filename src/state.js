import fs from 'fs';
import path from 'path';

const defaultState = () => ({
  processed: {},
  recent_decisions: [],
  recent_sends: [],
  token_events: [],
  alerts: {
    gmail_down_at: 0,
    gmail_last_alert_at: 0,
    llm_down_at: 0,
    llm_last_alert_at: 0
  },
  stats: {
    emails_processed: 0,
    llm_requests: 0,
    notifications_sent: 0,
    tokens_total_est: 0,
    last_24h_tokens_est: 0,
    gmail: { last_ok_at: 0, last_error: '', last_poll_at: 0 },
    llm: { last_ok_at: 0, last_error: '', last_latency_ms: 0, avg_latency_ms: 0, last_health_check_at: 0 },
    llm_queue: { depth: 0, pending: 0, running: 0, dropped_total: 0, last_dropped_at: 0, last_dropped_id: '', max_queue: 0 },
    twilio: { last_ok_at: 0, last_error: '', startup_ok_at: 0 },
    pushover: { last_ok_at: 0, last_error: '', startup_ok_at: 0 }
  }
});

const atomicWriteFile = async (filePath, data) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, data);
  await fs.promises.rename(tmpPath, filePath);
};

export const createStateManager = ({
  statePath,
  maxProcessedIds,
  recentLimit,
  tokenEventLimit = 5000
}) => {
  let state = defaultState();
  let saveQueue = Promise.resolve();

  const load = async () => {
    try {
      const raw = await fs.promises.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      const base = defaultState();
      state = {
        ...base,
        ...parsed,
        alerts: { ...base.alerts, ...(parsed.alerts || {}) },
        stats: { ...base.stats, ...(parsed.stats || {}) }
      };
      computeLast24h();
    } catch (err) {
      state = defaultState();
      await save();
    }
    return state;
  };

  const save = async () => {
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        prune();
        computeLast24h();
        await atomicWriteFile(statePath, JSON.stringify(state, null, 2));
        return state;
      });
    return saveQueue;
  };

  const computeLast24h = () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    state.token_events = state.token_events.filter((e) => e.ts >= cutoff);
    const total24h = state.token_events.reduce((sum, e) => sum + (e.tokens || 0), 0);
    state.stats.last_24h_tokens_est = Math.round(total24h);
  };

  const prune = () => {
    const processedEntries = Object.entries(state.processed || {});
    if (processedEntries.length > maxProcessedIds) {
      const sorted = processedEntries.sort((a, b) => (a[1]?.processed_at || 0) - (b[1]?.processed_at || 0));
      const toDrop = sorted.slice(0, processedEntries.length - maxProcessedIds);
      for (const [id] of toDrop) delete state.processed[id];
    }
    state.recent_decisions = (state.recent_decisions || []).slice(-recentLimit);
    state.recent_sends = (state.recent_sends || []).slice(-recentLimit);
    state.token_events = (state.token_events || []).slice(-tokenEventLimit);
  };

  const markProcessed = (id, status = 'ok', error = '') => {
    state.processed[id] = { processed_at: Date.now(), status, error };
    state.stats.emails_processed += 1;
  };

  const addDecision = (decision) => {
    state.recent_decisions.push(decision);
  };

  const addSend = (send) => {
    state.recent_sends.push(send);
    state.stats.notifications_sent += 1;
  };

  const addTokenEvent = (tokens) => {
    const t = Number.isFinite(tokens) ? tokens : 0;
    state.token_events.push({ ts: Date.now(), tokens: t });
    state.stats.tokens_total_est += t;
    computeLast24h();
  };

  const bumpLLMRequests = () => {
    state.stats.llm_requests += 1;
  };

  const recordGmailPoll = () => {
    state.stats.gmail.last_poll_at = Date.now();
  };

  const revertGmailPoll = (previousTimestamp) => {
    state.stats.gmail.last_poll_at = previousTimestamp;
  };

  const setGmailOk = () => {
    state.stats.gmail.last_ok_at = Date.now();
    state.stats.gmail.last_error = '';
    state.alerts.gmail_down_at = 0;
  };

  const setGmailError = (errMsg) => {
    state.stats.gmail.last_error = errMsg;
    state.alerts.gmail_down_at ||= Date.now();
  };

  const clearGmailError = () => {
    state.stats.gmail.last_error = '';
    state.alerts.gmail_down_at = 0;
  };

  const setLLMOk = (latencyMs) => {
    const now = Date.now();
    state.stats.llm.last_ok_at = now;
    state.stats.llm.last_error = '';
    state.stats.llm.last_latency_ms = latencyMs;
    const prevAvg = state.stats.llm.avg_latency_ms || 0;
    state.stats.llm.avg_latency_ms = prevAvg === 0 ? latencyMs : Math.round((prevAvg + latencyMs) / 2);
    state.alerts.llm_down_at = 0;
  };

  const setLLMError = (errMsg) => {
    state.stats.llm.last_error = errMsg;
    state.alerts.llm_down_at ||= Date.now();
  };

  const setLLMHealthCheck = (ok, latencyMs, errMsg = '') => {
    state.stats.llm.last_health_check_at = Date.now();
    if (ok) {
      setLLMOk(latencyMs);
    } else if (errMsg) {
      setLLMError(errMsg);
    }
  };

  const setLLMQueueStats = (queueStats = {}) => {
    state.stats.llm_queue = { ...state.stats.llm_queue, ...queueStats };
  };

  const incrementLLMQueueDropped = (messageId = '') => {
    state.stats.llm_queue.dropped_total += 1;
    state.stats.llm_queue.last_dropped_at = Date.now();
    state.stats.llm_queue.last_dropped_id = messageId || state.stats.llm_queue.last_dropped_id;
  };

  const setTwilioOk = () => {
    const now = Date.now();
    state.stats.twilio.last_ok_at = now;
    state.stats.twilio.startup_ok_at ||= now;
    state.stats.twilio.last_error = '';
  };

  const setTwilioError = (errMsg) => {
    state.stats.twilio.last_error = errMsg;
  };

  const setPushoverOk = () => {
    const now = Date.now();
    state.stats.pushover.last_ok_at = now;
    state.stats.pushover.startup_ok_at ||= now;
    state.stats.pushover.last_error = '';
  };

  const setPushoverError = (errMsg) => {
    state.stats.pushover.last_error = errMsg;
  };

  const markOutageAlertSent = (service) => {
    const now = Date.now();
    if (service === 'gmail') state.alerts.gmail_last_alert_at = now;
    if (service === 'llm') state.alerts.llm_last_alert_at = now;
  };

  const getState = () => state;

  return {
    load,
    save,
    getState,
    markProcessed,
    addDecision,
    addSend,
    addTokenEvent,
    bumpLLMRequests,
    recordGmailPoll,
    revertGmailPoll,
    setGmailOk,
    setGmailError,
    clearGmailError,
    setLLMOk,
    setLLMError,
    setLLMHealthCheck,
    setLLMQueueStats,
    incrementLLMQueueDropped,
    setTwilioOk,
    setTwilioError,
    setPushoverOk,
    setPushoverError,
    markOutageAlertSent
  };
};
