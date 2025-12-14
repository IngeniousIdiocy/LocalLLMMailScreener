## Operating Notes

- Poll loop is single-threaded with a lock; per-email processing is gated by a small concurrency limiter (see `MAX_CONCURRENCY`).
- State is kept in JSON at `STATE_PATH` with atomic writes; processed IDs are pruned to `MAX_PROCESSED_IDS`.
- LLM calls always happen for every new email; invalid JSON responses are recorded as errors and the message is still marked processed.
- SMS sends are truncated to `MAX_SMS_CHARS`; when `DRY_RUN=true`, no Twilio call is made but events are recorded.
- Dashboard pulls `/api/status` every 2 seconds and renders health (Gmail/LLM/Twilio), token stats, and recent sends.
