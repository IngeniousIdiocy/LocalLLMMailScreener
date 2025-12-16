## Operating Notes

- Poll loop is single-threaded with a lock; Gmail polls enqueue into a bounded LLM queue (`MAX_LLM_QUEUE`) drained by `MAX_LLM_CONCURRENCY` workers. Oldest pending emails are dropped (counted) if the queue would overflow.
- State is kept in JSON at `STATE_PATH` with atomic writes; processed IDs are pruned to `MAX_PROCESSED_IDS`.
- LLM calls always happen for every new email; invalid JSON responses are recorded as errors and the message is still marked processed.
- SMS sends are truncated to `MAX_SMS_CHARS`; when `DRY_RUN=true`, no Twilio call is made but events are recorded.
- Dashboard pulls `/api/status` every 2 seconds and renders health (Gmail/LLM/Twilio), token stats, and recent sends.
