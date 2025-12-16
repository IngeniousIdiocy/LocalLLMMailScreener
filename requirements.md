## Requirements Coverage

- Gmail: OAuth2 via `googleapis`; polls inbox (`users.messages.list/get format=raw`) using `GMAIL_QUERY`, tracks processed IDs to avoid duplicates.
- LLM: Sends full parsed email JSON to local OpenAI-compatible endpoint (`LLM_BASE_URL/v1/chat/completions`) with strict JSON system prompt; handles auth header when `LLM_API_KEY` is set; estimates tokens with fallback heuristic.
- Twilio: Official SDK; startup credential check; notifications honor `DRY_RUN`; SMS body truncated to `MAX_SMS_CHARS`.
- State: JSON file at `STATE_PATH`, atomic writes, keeps processed map, recent decisions/sends, token events, and stats with pruning.
- Control: Poll lock to avoid overlap; bounded LLM queue (capped by `MAX_LLM_QUEUE`) drained by `MAX_LLM_CONCURRENCY` workers; health checks per spec for Gmail/LLM/Twilio.
- UI/API: Express server hosting `/` dashboard and `/api/status` JSON; dashboard shows health, recent sends, token totals, last 24h estimate, counts.
