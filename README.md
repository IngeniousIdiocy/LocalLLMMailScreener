## Local LLM Mail Screener

Node.js (ESM) service that polls Gmail, sends each new email to a local OpenAI-compatible LLM, and optionally forwards summarized notifications based on the LLMs assessment of importance via Twilio SMS or Pushover (emergency mode). Includes a lightweight dashboard and JSON status API.

![Dashboard UI Screenshot](https://raw.githubusercontent.com/IngeniousIdiocy/LocalLLMMailScreener/main/Dashboard_UI_Screenshot.png)

---

### Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          LOCAL LLM MAIL SCREENER                           │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                         EXPRESS SERVER (:3000)                      │  │
│   │  ┌──────────────────────┐    ┌──────────────────────────────────┐   │  │
│   │  │   Dashboard (HTML)   │    │       API Endpoint               │   │  │
│   │  │      GET /           │    │       GET /api/status            │   │  │
│   │  │                      │    │                                  │   │  │
│   │  │  • Health indicators │    │  • Health/stats JSON             │   │  │
│   │  │  • Token estimates   │    │  • Recent sends & decisions      │   │  │
│   │  │  • Recent SMS sends  │    │  • Config (sanitized)            │   │  │
│   │  └──────────────────────┘    └──────────────────────────────────┘   │  │
│   └─────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐  │
│   │                           CORE SERVICES                             │  │
│   │                                                                     │  │
│   │   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐     │  │
│   │   │ gmail.js    │    │   llm.js    │    │     twilio.js       │     │  │
│   │   │             │    │             │    │                     │     │  │
│   │   │ • OAuth2    │    │ • OpenAI    │    │ • SMS sending       │     │  │
│   │   │ • List msgs │    │   compat    │    │ • Credential check  │     │  │
│   │   │ • Fetch raw │    │ • JSON mode │    │ • DRY_RUN support   │     │  │
│   │   │ • Parse     │    │ • Timeouts  │    │ • Truncation        │     │  │
│   │   └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘     │  │
│   │          │                  │                      │                │  │
│   └──────────┼──────────────────┼──────────────────────┼────────────────┘  │
│              │                  │                      │                   │
│   ┌──────────┴──────────────────┴──────────────────────┴───────────────┐   │
│   │                          index.js                                  │   │
│   │                       (Orchestrator)                               │   │
│   │                                                                    │   │
│   │  • Polling loop with lock       • Concurrency limiter              │   │
│   │  • Message processing           • Health monitoring                │   │
│   │  • Decision routing             • Error handling                   │   │
│   └────────────────────────────────────┬───────────────────────────────┘   │
│                                        │                                   │
│   ┌────────────────────────────────────┴───────────────────────────────┐   │
│   │                          state.js                                  │   │
│   │                      (Persistence Layer)                           │   │
│   │                                                                    │   │
│   │  • Processed IDs map            • Recent decisions/sends           │   │
│   │  • Token usage tracking         • Atomic JSON writes               │   │
│   │  • Stats per service            • Auto-pruning                     │   │
│   └────────────────────────────────────────────────────────────────────┘   │
│                                        │                                   │
│                                        ▼                                   │
│                              ./data/state.json                             │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘

                    EXTERNAL SERVICES
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│   Gmail API       │  │  Local LLM        │  │   Notifier API    │
│   (googleapis)    │  │  (OpenAI compat)  │  │  Twilio or        │
│                   │  │                   │  │  Pushover         │
│  users.messages   │  │ /v1/chat/         │  │                   │
│  .list / .get     │  │   completions     │  │                   │
└───────────────────┘  └───────────────────┘  └───────────────────┘
```

---

### Email Processing Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│     ╔═══════════════╗                                                        │
│     ║   INCOMING    ║                                                        │
│     ║    EMAIL      ║                                                        │
│     ╚═══════╤═══════╝                                                        │
│             │                                                                │
│             ▼                                                                │
│     ┌───────────────┐                                                        │
│     │  Gmail Inbox  │                                                        │
│     └───────┬───────┘                                                        │
│             │                                                                │
│             │  (sits in inbox)                                               │
│             ▼                                                                │
│     ┌───────────────────────────────────────────────────────────────────┐    │
│     │                    POLL INTERVAL TIMER                            │    │
│     │                 (default: every 15 seconds)                       │    │
│     └───────────────────────────────┬───────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│     ┌───────────────────────────────────────────────────────────────────┐    │
│     │                  LIST MESSAGES (Gmail API)                        │    │
│     │           users.messages.list with GMAIL_QUERY filter             │    │
│     │                    (e.g., newer_than:7d)                          │    │
│     └───────────────────────────────┬───────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│                        ┌────────────────────────┐                            │
│                        │   Already processed?   │                            │
│                        │   (check state.json)   │                            │
│                        └────────────┬───────────┘                            │
│                                     │                                        │
│                    ┌────────────────┴────────────────┐                       │
│                    │ YES                         NO  │                       │
│                    ▼                                 ▼                       │
│           ┌──────────────┐              ┌──────────────────────┐             │
│           │    SKIP      │              │   FETCH RAW MESSAGE  │             │
│           │  (continue)  │              │  (format=raw, Base64)│             │
│           └──────────────┘              └──────────┬───────────┘             │
│                                                    │                         │
│                                                    ▼                         │
│                                         ┌──────────────────────┐             │
│                                         │    PARSE EMAIL       │             │
│                                         │  • Decode MIME       │             │
│                                         │  • Extract headers   │             │
│                                         │  • Get body text     │             │
│                                         │  • List attachments  │             │
│                                         └──────────┬───────────┘             │
│                                                    │                         │
│                                                    ▼                         │
│     ┌───────────────────────────────────────────────────────────────────┐    │
│     │                     SEND TO LOCAL LLM                             │    │
│     │              POST /v1/chat/completions                            │    │
│     │                                                                   │    │
│     │   Prompt includes:                                                │    │
│     │   • Trimmed email JSON (key headers, cleaned body text,           │    │
│     │     attachment metadata only)                                     │    │
│     │   • Instructions to output strict JSON with:                      │    │
│     │     { notify: bool, message_packet: {...}, confidence, reason }   │    │
│     └───────────────────────────────┬───────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│                        ┌────────────────────────┐                            │
│                        │   Parse LLM Response   │                            │
│                        │   (strict JSON mode)   │                            │
│                        └────────────┬───────────┘                            │
│                                     │                                        │
│                    ┌────────────────┴────────────────┐                       │
│                    │                                 │                       │
│                    ▼                                 ▼                       │
│     ┌─────────────────────────┐       ┌─────────────────────────────────┐    │
│     │    notify: false        │       │        notify: true             │    │
│     │                         │       │                                 │    │
│     │  ┌───────────────────┐  │       │  ┌───────────────────────────┐  │    │
│     │  │    DISREGARD      │  │       │  │   BUILD SMS MESSAGE       │  │    │
│     │  │                   │  │       │  │                           │  │    │
│     │  │  Email deemed not │  │       │  │  • Title + [urgency]      │  │    │
│     │  │  worthy of notify │  │       │  │  • Body summary           │  │    │
│     │  │                   │  │       │  │  • Truncate to MAX_CHARS  │  │    │
│     │  │  Reason logged:   │  │       │  │                           │  │    │
│     │  │  e.g., "marketing │  │       │  └─────────────┬─────────────┘  │    │
│     │  │  newsletter"      │  │       │                │                │    │
│     │  └───────────────────┘  │       │                ▼                │    │
│     │                         │       │  ┌───────────────────────────┐  │    │
│     │                         │       │  │     TWILIO SMS API        │  │    │
│     │                         │       │  │    messages.create        │  │    │
│     │                         │       │  │                           │  │    │
│     │                         │       │  │  (skipped if DRY_RUN)     │  │    │
│     │                         │       │  └─────────────┬─────────────┘  │    │
│     │                         │       │                │                │    │
│     │                         │       │                ▼                │    │
│     │                         │       │  ┌───────────────────────────┐  │    │
│     │                         │       │  │   📱 SMS DELIVERED        │  │    │
│     │                         │       │  │   to TWILIO_TO number     │  │    │
│     │                         │       │  │                           │  │    │
│     │                         │       │  │   Subscriber receives:    │  │    │
│     │                         │       │  │   "Subject [urgent]       │  │    │
│     │                         │       │  │    Brief summary..."      │  │    │
│     │                         │       │  └───────────────────────────┘  │    │
│     └────────────┬────────────┘       └─────────────────┬───────────────┘    │
│                  │                                      │                    │
│                  └──────────────────┬───────────────────┘                    │
│                                     │                                        │
│                                     ▼                                        │
│     ┌───────────────────────────────────────────────────────────────────┐    │
│     │                      UPDATE STATE                                 │    │
│     │                                                                   │    │
│     │  • Mark message ID as processed                                   │    │
│     │  • Record decision (notify/reason/confidence)                     │    │
│     │  • Log token usage for billing estimates                          │    │
│     │  • If sent: record in recent_sends with twilio_sid                │    │
│     │  • Atomic write to state.json                                     │    │
│     └───────────────────────────────────────────────────────────────────┘    │
│                                     │                                        │
│                                     ▼                                        │
│                          ┌──────────────────┐                                │
│                          │  WAIT FOR NEXT   │                                │
│                          │  POLL INTERVAL   │──────────────────────┐         │
│                          └──────────────────┘                      │         │
│                                                                    │         │
│                                     ▲                              │         │
│                                     └──────────────────────────────┘         │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

LEGEND:
  ═══  Start/End points
  ───  Process boxes
  ─┬─  Decision points
   │   Flow direction
   ▼   Flow arrows
```

---

### Quick start
1. `npm install`
2. `cp .env.example .env` and fill in secrets (Gmail OAuth refresh token, Twilio creds, etc.).
3. `npm start`
4. Visit `http://localhost:3000/` for the dashboard. JSON status is at `GET /api/status`.

### Environment
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (OAuth2, userId=`me`)
- Notification:
  - `NOTIFICATION_SERVICE` (`twilio` | `pushover`, default `twilio`)
  - Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`
  - Pushover (emergency priority=2): `PUSHOVER_TOKEN` (or `PUSHOVER_API_TOKEN`), `PUSHOVER_USER`, optional `PUSHOVER_DEVICE`
- Optional knobs: `PORT`, `POLL_INTERVAL_MS`, `POLL_GRACE_MS` (default 5000ms overlap to avoid gaps), `POLL_WINDOW_MS` (override window size; defaults to `POLL_INTERVAL_MS`), `POLL_MAX_RESULTS`, `GMAIL_SUMMARY_INTERVAL_MIN` (minutes between Gmail poll summaries; set <=0 to log every poll instead), `GMAIL_QUERY`, `STATE_PATH`, `MAX_PROCESSED_IDS`, `RECENT_LIMIT`, `MAX_SMS_CHARS`, `MAX_EMAIL_BODY_CHARS`, `MAX_LLM_CONCURRENCY` (alias: legacy `MAX_CONCURRENCY`), `MAX_LLM_QUEUE` (default 20), `DRY_RUN`, `LOG_DASHBOARD_REQUESTS` (default false), `LLM_*` (base URL/model/temperature/timeouts), `SYSTEM_PROMPT_PATH` (default `./data/system_prompt.txt`)

### System Prompt
The LLM system prompt is loaded from an external file, allowing you to customize the screening behavior without restarting the server. The prompt is re-read from disk on every LLM call, so edits take effect immediately on the next email processed.

- **Default location**: `./data/system_prompt.txt`
- **Override via**: `SYSTEM_PROMPT_PATH` environment variable
- **Fallback**: If the file is missing or unreadable, a minimal default prompt is used

Edit `data/system_prompt.txt` to customize:
- What types of emails trigger notifications
- How urgency levels are assigned
- Domain-specific rules (e.g., security alerts, family events)
- Output format requirements

### Behavior
- Polls Gmail inbox on the configured interval and immediately enqueues any new IDs found (bounded by `MAX_LLM_QUEUE`, default 20). The Gmail poll itself does not wait for LLM work. Oldest queued emails are dropped (counted in stats) if the queue would exceed the cap. Each poll still uses `after:<now - (POLL_WINDOW_MS||POLL_INTERVAL_MS) - POLL_GRACE_MS>` (default 5s grace); widen the window if processing delays exceed the interval. Successful polls are summarized every `GMAIL_SUMMARY_INTERVAL_MIN` minutes (default 15, first summary after the first poll), while failures still log immediately.
- Emails are normalized and trimmed before LLM use (reply chains/forwards and footer noise removed, attachments kept as metadata only, body capped to `MAX_EMAIL_BODY_CHARS`, default 4000, with head+tail preserved).
- Every enqueued email is sent to the local LLM (`/v1/chat/completions`), enforcing strict JSON output, with `MAX_LLM_CONCURRENCY` parallel workers (default 3).
- If `notify=true`, sends via the configured notification service:
  - Twilio SMS (truncated to `MAX_SMS_CHARS`, or skipped when `DRY_RUN=true`).
  - Pushover emergency mode (priority=2) with `retry=100`, `expire=7d`, using the same truncated body.
- State (processed IDs, decisions, sends, token stats, queue stats) persists to `STATE_PATH` atomically.
- Dashboard shows Gmail/LLM/Notification health, token estimates (total + last 24h), LLM queue depth/drops, average TPS over the last five emails, and recent notifications.

### Endpoints
- `GET /` — dashboard UI
- `GET /api/status` — health/stats/recent sends as JSON

### Notes
- Uses a bounded LLM queue (`MAX_LLM_QUEUE`) with `MAX_LLM_CONCURRENCY` workers; oldest pending emails are dropped (counted in stats) when the queue would overflow.
- Token estimation uses `usage.total_tokens` when present, otherwise `(input_chars + output_chars)/4` (ceil).
- Health rules: Gmail = success within 2× poll interval; LLM = success within 5 min or recent health check; Notification (Twilio/Pushover) = success within 24h or startup credential check.

### Testing
- `npm test` runs mocked scenarios (no external calls) plus parser checks:
  - Happy-path notify, invalid LLM JSON, Twilio send failure, LLM timeout handling
  - Raw email parsing (plain text and HTML-only)
- Fixtures: `test/fixtures/emails.json`, `test/fixtures/llm_responses.json`, raw `.eml` files under `test/fixtures/raw/`, judgment set in `test/fixtures/llm_judgment_cases.json`.
- Optional integration toggles (skipped unless enabled):
  - `TEST_REAL_LLM=1 npm test` → real LLM, mocked Gmail/Twilio
  - `TEST_REAL_LLM=1 TEST_REAL_GMAIL=1 npm test` → real Gmail+LLM, mocked Twilio (requires Gmail creds set)
  - `TEST_REAL_TWILIO=1 npm test` → real Twilio single-message smoke (uses `.env` creds)
  - `TEST_REAL_PUSHOVER=1 npm test` → real Pushover emergency-mode single-message smoke (uses `.env` creds: `PUSHOVER_TOKEN` or `PUSHOVER_API_TOKEN`, plus `PUSHOVER_USER`)
  - Shorthand: `REAL=GLPT npm test` sets `TEST_REAL_GMAIL/LLM/PUSHOVER/TWILIO` based on letters (any order, case-insensitive).
- LLM debug logging during real-LLM test: add `TEST_LLM_DEBUG=1 npm test` to print request IDs, latency, tokens, and raw content from the local LLM in the real-LLM scenario.
- Real LLM judgment checks (skipped unless `TEST_REAL_LLM=1`): per-email tests named after the subject, using controlled urgent/non-urgent mocks from `test/fixtures/llm_judgment_cases.json` + raw `.eml` files.

### License
This project is licensed under the [MIT License](LICENSE).
