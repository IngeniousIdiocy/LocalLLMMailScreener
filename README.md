## Local LLM Mail Screener

Node.js (ESM) service that polls Gmail, sends each new email to a local OpenAI-compatible LLM, and optionally forwards summarized notifications based on the LLM's assessment of importance via Twilio SMS or Pushover (emergency mode). Includes a lightweight dashboard and JSON status API.

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
│   │   │ gmail.js    │    │   llm.js    │    │   Notification Svc  │     │  │
│   │   │             │    │             │    │ ┌─────────────────┐ │     │  │
│   │   │ • OAuth2    │    │ • OpenAI    │    │ │ twilio.js       │ │     │  │
│   │   │ • List msgs │    │   compat    │    │ │ • SMS sending   │ │     │  │
│   │   │ • Fetch raw │    │ • JSON mode │    │ ├─────────────────┤ │     │  │
│   │   │ • Parse     │    │ • Timeouts  │    │ │ pushover.js     │ │     │  │
│   │   │             │    │             │    │ │ • Push notifs   │ │     │  │
│   │   │             │    │             │    │ │ • Emergency pri │ │     │  │
│   │   │             │    │             │    │ └─────────────────┘ │     │  │
│   │   │             │    │             │    │ • DRY_RUN support   │     │  │
│   │   │             │    │             │    │ • Credential check  │     │  │
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
│   Gmail API       │  │  Local LLM        │  │   Notification    │
│   (googleapis)    │  │  (OpenAI compat)  │  │                   │
│                   │  │                   │  │  ┌─────────────┐  │
│  users.messages   │  │ /v1/chat/         │  │  │ Twilio SMS  │  │
│  .list / .get     │  │   completions     │  │  └─────────────┘  │
│                   │  │                   │  │  ┌─────────────┐  │
│                   │  │                   │  │  │ Pushover    │  │
│                   │  │                   │  │  │ (emergency) │  │
│                   │  │                   │  │  └─────────────┘  │
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
│     │  │    DISREGARD      │  │       │  │   BUILD NOTIFICATION      │  │    │
│     │  │                   │  │       │  │                           │  │    │
│     │  │  Email deemed not │  │       │  │  • Title + [urgency]      │  │    │
│     │  │  worthy of notify │  │       │  │  • Body summary           │  │    │
│     │  │                   │  │       │  │  • Truncate to MAX_CHARS  │  │    │
│     │  │  Reason logged:   │  │       │  │                           │  │    │
│     │  │  e.g., "marketing │  │       │  └─────────────┬─────────────┘  │    │
│     │  │  newsletter"      │  │       │                │                │    │
│     │  └───────────────────┘  │       │                ▼                │    │
│     │                         │       │  ┌───────────────────────────┐  │    │
│     │                         │       │  │   NOTIFICATION SERVICE    │  │    │
│     │                         │       │  │  (based on config)        │  │    │
│     │                         │       │  │                           │  │    │
│     │                         │       │  │  ┌─────────┐ ┌─────────┐  │  │    │
│     │                         │       │  │  │ Twilio  │ │Pushover │  │  │    │
│     │                         │       │  │  │   SMS   │ │  Push   │  │  │    │
│     │                         │       │  │  └─────────┘ └─────────┘  │  │    │
│     │                         │       │  │                           │  │    │
│     │                         │       │  │  (skipped if DRY_RUN)     │  │    │
│     │                         │       │  └─────────────┬─────────────┘  │    │
│     │                         │       │                │                │    │
│     │                         │       │                ▼                │    │ 
│     │                         │       │  ┌───────────────────────────┐  │    │
│     │                         │       │  │    NOTIFICATION SENT      │  │    │
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
│     │  • If sent: record in recent_sends with notification ID           │    │
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

### Setup

#### Prerequisites

- **Node.js** (v18+ recommended)
- **Local LLM server** — Any OpenAI-compatible endpoint (e.g., llama.cpp server, Ollama, LM Studio, vLLM)
- **Gmail account** with API access enabled
- **Notification provider** (one of):
  - **Twilio** account for SMS notifications
  - **Pushover** account for push notifications (supports emergency priority)

#### Dependencies

Install Node.js dependencies:

```bash
npm install
```

This installs:
- `googleapis` — Gmail API access via OAuth2
- `axios` — HTTP client for LLM and Pushover API calls
- `express` — Web server for dashboard and status API
- `dotenv` — Environment variable loading
- `mailparser` — MIME email parsing
- `html-to-text` — HTML to plain text conversion for email bodies
- `twilio` — Twilio SDK for SMS (optional, only if using Twilio)

#### Gmail OAuth2 Setup

Gmail access requires OAuth2 credentials. The `gmailtest/` directory contains a helper utility to obtain your refresh token:

1. **Create Google Cloud Project & Credentials:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create or select a project
   - Enable the **Gmail API** (APIs & Services → Library)
   - Configure OAuth consent screen (APIs & Services → OAuth consent screen):
     - User type: External (for personal Gmail) or Internal (Workspace)
     - Add yourself as a test user if External
   - Create OAuth credentials (APIs & Services → Credentials → Create Credentials → OAuth client ID → **Desktop app**)
   - Copy the **Client ID** and **Client Secret**

2. **Generate Refresh Token:**

   ```bash
   cd gmailtest
   cp .env.example .env
   # Edit .env with your GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GMAIL_USER
   npm install
   npm run get-token
   ```

   Follow the prompts to authorize Gmail access. The script will output a `GOOGLE_REFRESH_TOKEN` — copy this to your main `.env` file.

   See `gmailtest/README.md` for detailed instructions.

#### Local LLM Setup

Any OpenAI-compatible server works. The endpoint must support `POST /v1/chat/completions` with JSON responses. Examples:

- **llama.cpp server**: `./server -m model.gguf --port 8080`
- **Ollama**: `ollama serve` (default port 11434, use `LLM_BASE_URL=http://localhost:11434/v1`)
- **LM Studio**: Enable server mode in settings

The system prompt (`./data/system_prompt.txt`) instructs the LLM to output strict JSON for email triage decisions. Edit this file to customize screening rules.

#### Notification Provider Setup

Set `NOTIFICATION_SERVICE` to `twilio` or `pushover` in your `.env`:

**Twilio (SMS):**
- Create account at [twilio.com](https://www.twilio.com/)
- Get Account SID, Auth Token, and a phone number
- Set: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`

**Pushover (Push Notifications):**
- Create account at [pushover.net](https://pushover.net/)
- Create an application to get an API token
- Set: `PUSHOVER_TOKEN` (or `PUSHOVER_API_TOKEN`), `PUSHOVER_USER`, optionally `PUSHOVER_DEVICE`
- Pushover uses emergency priority (level 2) with retry/acknowledge

#### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

**Required:**
```env
# Gmail OAuth2
GMAIL_CLIENT_ID=your_client_id
GMAIL_CLIENT_SECRET=your_client_secret
GMAIL_REFRESH_TOKEN=your_refresh_token

# Notification (choose one)
NOTIFICATION_SERVICE=pushover   # or 'twilio'

# Pushover credentials
PUSHOVER_TOKEN=your_app_token
PUSHOVER_USER=your_user_key

# OR Twilio credentials
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_FROM=+1234567890
TWILIO_TO=+0987654321
```

**Optional tuning:**
```env
PORT=3000                           # Dashboard port
LLM_BASE_URL=http://127.0.0.1:8080  # Local LLM endpoint
LLM_MODEL=local-model               # Model identifier
POLL_INTERVAL_MS=15000              # Gmail poll interval
GMAIL_QUERY=newer_than:1d           # Gmail search filter
MAX_SMS_CHARS=900                   # Notification body limit
MAX_EMAIL_BODY_CHARS=4000           # Email body sent to LLM
DRY_RUN=false                       # Set true to skip actual notifications
```

#### Running

```bash
npm start
```

Visit `http://localhost:3000/` for the dashboard. JSON status is at `GET /api/status`.

---

### Environment Variables

**Gmail:**
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (OAuth2, userId=`me`)

**Notification:**
- `NOTIFICATION_SERVICE` (`twilio` | `pushover`, default `twilio`)
- **Twilio**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`
- **Pushover** (emergency priority=2): `PUSHOVER_TOKEN` (or `PUSHOVER_API_TOKEN`), `PUSHOVER_USER`, optional `PUSHOVER_DEVICE`

**Optional knobs:**
- `PORT`, `POLL_INTERVAL_MS`, `POLL_GRACE_MS` (default 5000ms overlap to avoid gaps), `POLL_WINDOW_MS` (override window size; defaults to `POLL_INTERVAL_MS`), `POLL_MAX_RESULTS`
- `GMAIL_SUMMARY_INTERVAL_MIN` (minutes between Gmail poll summaries; set <=0 to log every poll instead), `GMAIL_QUERY`
- `STATE_PATH`, `MAX_PROCESSED_IDS`, `RECENT_LIMIT`
- `MAX_SMS_CHARS`, `MAX_EMAIL_BODY_CHARS`
- `MAX_LLM_CONCURRENCY` (alias: legacy `MAX_CONCURRENCY`), `MAX_LLM_QUEUE` (default 20)
- `DRY_RUN`, `LOG_DASHBOARD_REQUESTS` (default false)
- `LLM_*` (base URL/model/temperature/timeouts), `SYSTEM_PROMPT_PATH` (default `./data/system_prompt.txt`)

---

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

---

### Behavior

- Polls Gmail inbox on the configured interval and immediately enqueues any new IDs found (bounded by `MAX_LLM_QUEUE`, default 20). The Gmail poll itself does not wait for LLM work. Oldest queued emails are dropped (counted in stats) if the queue would exceed the cap. Each poll still uses `after:<now - (POLL_WINDOW_MS||POLL_INTERVAL_MS) - POLL_GRACE_MS>` (default 5s grace); widen the window if processing delays exceed the interval. Successful polls are summarized every `GMAIL_SUMMARY_INTERVAL_MIN` minutes (default 15, first summary after the first poll), while failures still log immediately.
- Emails are normalized and trimmed before LLM use (reply chains/forwards and footer noise removed, attachments kept as metadata only, body capped to `MAX_EMAIL_BODY_CHARS`, default 4000, with head+tail preserved).
- **Phishing Detection**: URLs are extracted and analyzed before LLM processing (see [Phishing Detection](#phishing-detection) below). The LLM receives structured `url_analysis` and `sender_analysis` fields to identify spearphishing attempts.
- Every enqueued email is sent to the local LLM (`/v1/chat/completions`), enforcing strict JSON output, with `MAX_LLM_CONCURRENCY` parallel workers (default 3).
- If `notify=true`, sends via the configured notification service:
  - **Twilio SMS**: truncated to `MAX_SMS_CHARS`, or skipped when `DRY_RUN=true`.
  - **Pushover**: emergency mode (priority=2) with `retry=100`, `expire=7d`, using the same truncated body.
- State (processed IDs, decisions, sends, token stats, queue stats) persists to `STATE_PATH` atomically.
- Dashboard shows Gmail/LLM/Notification health, token estimates (total + last 24h), LLM queue depth/drops, average TPS over the last five emails, and recent notifications.

---

### Phishing Detection

The system includes automatic URL extraction and analysis to help the LLM identify spearphishing attempts. This is critical because phishing emails often use urgent language (which would normally trigger notifications) but contain deceptive links.

#### How It Works

1. **URL Extraction** (`src/url_extract.js`): Before sending email to the LLM, all URLs are extracted from the body:
   - HTML anchor tags: captures both display text and actual `href` destination
   - Plaintext URLs: finds `http://` and `https://` links

2. **Root Domain Analysis**: For each URL, the root domain is extracted:
   - `mail.google.com` → `google.com`
   - `paypal.scammer.ru` → `scammer.ru` (NOT PayPal!)
   - Handles multi-part TLDs like `.co.uk`, `.com.au`

3. **IP-Based URL Detection** (CRITICAL): Flags URLs that use raw IP addresses instead of domains:
   - IPv6: `http://[0000:0000:0000:0000:0000:ffff:1769:2bd4]/verify`
   - IPv4: `http://192.168.1.100/login.php`
   - Decimal IPs: `http://3232235777/` (obscured IPv4)
   - **No legitimate company ever sends links to raw IP addresses** — this is an instant phishing indicator

4. **Mismatch Detection**: Flags when display text shows one domain but link goes elsewhere:
   - Display: `https://apple.com/verify` → Href: `https://apple.id-verify.scamsite.ru`
   - This is a classic phishing technique

5. **LLM-Evaluated Checks** (system prompt instructs LLM to use the extracted data):
   - **Sender vs Claimed Brand**: Does sender domain match who the email claims to be from?
   - **Gibberish Domains**: Do the URLs point to random-looking domains like `yboovtmptefy.edu`?
   - **Suspicious Domain Names**: Domains containing brand names but aren't legitimate (e.g., `google-security.com`, `paypal-verify.net`)

#### Data Provided to LLM

Each email sent to the LLM includes:

```json
{
  "url_analysis": {
    "count": 1,
    "unique_domains": ["[::ffff:1769:2bd4]"],
    "has_ip_based_urls": true,
    "has_mismatched_urls": false
  },
  "sender_analysis": {
    "email": "cloud@semaslim.net",
    "display_name": "Cloud Storage",
    "domain": "semaslim.net",
    "root_domain": "semaslim.net"
  }
}
```

#### System Prompt Rules

The system prompt (`data/system_prompt.txt`) includes rules for the LLM to use this data:

**Automated red flags** (code detects, LLM instructed to treat as phishing → `notify: false`):
- If `has_ip_based_urls` is true → URLs link to raw IP addresses (no legitimate company does this)
- If `has_mismatched_urls` is true → display text shows one domain but links elsewhere

**LLM judgment required**:
- Sender domain vs claimed brand (e.g., `semaslim.net` claiming to be "Cloud Storage")
- Suspicious domain names containing brand names (e.g., `google-security.com`)
- Gibberish/random domain names in URLs
- Urgency combined with any red flags = spearphishing

Legitimate urgent emails have URLs pointing to the actual company domain AND sender domain matches.

#### Testing Phishing Detection

The test suite includes real LLM judgment tests for phishing scenarios (run with `TEST_REAL_LLM=1`):

- `phishing_fake_urgent.eml`: Fake iCloud storage warning with mismatched URLs (display shows apple.com, links to scamsite.ru) → should NOT notify
- `phishing_ip_based.eml`: Cloud storage scam using raw IP addresses (IPv6 and IPv4) in URLs → should NOT notify
- `legit_urgent_bank.eml`: Real bank fraud alert with legitimate wellsfargo.com URLs → SHOULD notify

Unit tests for URL extraction (`npm test`) cover:
- IP-based URL detection (IPv4, IPv6, decimal IPs)
- Root domain extraction
- Mismatch detection

---

### Endpoints

- `GET /` — dashboard UI
- `GET /api/status` — health/stats/recent sends as JSON

---

### Notes

- Uses a bounded LLM queue (`MAX_LLM_QUEUE`) with `MAX_LLM_CONCURRENCY` workers; oldest pending emails are dropped (counted in stats) when the queue would overflow.
- Token estimation uses `usage.total_tokens` when present, otherwise `(input_chars + output_chars)/4` (ceil).
- Health rules: Gmail = success within 2× poll interval; LLM = success within 5 min or recent health check; Notification (Twilio/Pushover) = success within 24h or startup credential check.

---

### Testing

- `npm test` runs mocked scenarios (no external calls) plus parser checks:
  - Happy-path notify, invalid LLM JSON, notification send failure, LLM timeout handling
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

---

### License

This project is licensed under the [MIT License](LICENSE).
