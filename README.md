## Local LLM Mail Screener

Node.js (ESM) service that polls Gmail, sends each new email to a local OpenAI-compatible LLM, and optionally forwards summarized notifications via Twilio SMS. Includes a lightweight dashboard and JSON status API.

### Quick start
1. `npm install`
2. `cp .env.example .env` and fill in secrets (Gmail OAuth refresh token, Twilio creds, etc.).
3. `npm start`
4. Visit `http://localhost:3000/` for the dashboard. JSON status is at `GET /api/status`.

### Environment
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (OAuth2, userId=`me`)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`
- Optional knobs: `PORT`, `POLL_INTERVAL_MS`, `POLL_MAX_RESULTS`, `GMAIL_QUERY`, `STATE_PATH`, `MAX_PROCESSED_IDS`, `RECENT_LIMIT`, `MAX_SMS_CHARS`, `MAX_CONCURRENCY`, `DRY_RUN`, `LLM_*` (base URL/model/temperature/timeouts)

### Behavior
- Polls Gmail inbox on the configured interval; fetches raw messages, parses to text (fallback from HTML).
- Every new email is sent to the local LLM (`/v1/chat/completions`), enforcing strict JSON output.
- If `notify=true`, sends SMS via Twilio (or skips when `DRY_RUN=true`) with truncation to `MAX_SMS_CHARS`.
- State (processed IDs, decisions, sends, token stats) persists to `STATE_PATH` atomically.
- Dashboard shows Gmail/LLM/Twilio health, token estimates (total + last 24h), and recent SMS sends.

### Endpoints
- `GET /` — dashboard UI
- `GET /api/status` — health/stats/recent sends as JSON

### Notes
- Uses concurrency limiting on email processing to avoid overloading the LLM.
- Token estimation uses `usage.total_tokens` when present, otherwise `(input_chars + output_chars)/4` (ceil).
- Health rules: Gmail = success within 2× poll interval; LLM = success within 5 min or recent health check; Twilio = success within 24h or startup credential check.

### Testing
- `npm test` runs four scenario tests with fully mocked Gmail/LLM/Twilio (no external calls).
- Mock fixtures live in `test/fixtures/emails.json` and `test/fixtures/llm_responses.json`; helpers in `test/helpers.js`.
- Scenarios covered: happy-path notify, invalid LLM JSON, Twilio send failure, and LLM timeout handling.
