# Prompt Tuning Loop - Requirements

## Overview

This mini-project implements an automated prompt tuning loop for the email screening system. The goal is to iteratively improve the system prompt by:
1. Collecting labeled examples of correct and incorrect classifications
2. Using Claude Sonnet 4.5 to analyze errors and propose prompt modifications
3. Re-evaluating the full dataset after each modification
4. Tracking progress and preventing regressions

## Problem Statement

Recent prompt tuning to prevent parseltongue/prompt injection attacks has caused an increase in false positive notifications (notifying for emails that shouldn't trigger notifications). This is frustrating because:
- Prompt injection is a theoretical threat (no real attacks observed)
- False positives are a real, ongoing annoyance

We need a systematic way to tune the prompt that balances security with practical utility.

---

## Data Structure

### Folder Layout

```
prompt-tuning/
├── requirements.md          # This file
├── config.json              # Configuration (max_attempts, model, etc.)
├── .env                     # Anthropic API key only (for tuning agent)
├── attempts_log.md          # Persistent log of all tuning attempts
├── current_prompt.txt       # Working copy of the system prompt being tuned
├── notified/                # Emails where LLM decided notify=true
│   └── {message_id}.json    # One file per email
├── notnotified/             # Emails where LLM decided notify=false
│   └── {message_id}.json
└── scripts/
    ├── backfill.js          # Fetches last 200 emails and populates data folders
    ├── evaluate.js          # Runs all emails through LLM, reports accuracy
    └── tune.js              # Main tuning agent loop

# Parent project provides:
../.env                           # LLM_BASE_URL, LLM_MODEL, LLM_API_KEY (for local LLM)

# Parseltongue tests loaded from parent project (ONLY these, ignore other test fixtures):
../test/fixtures/
├── prompt_injection_cases.json   # 8 parseltongue test cases (skip "basic" category)
└── raw/
    └── injection_*.eml           # Raw email files for each test
```

### Email JSON Schema

Each email file in `notified/` or `notnotified/` contains:

```json
{
  "id": "19b2f46d69d008cf",
  "gmail_link": "https://mail.google.com/mail/u/0/#inbox/19b2f46d69d008cf",
  "from": "\"Sender Name\" <sender@example.com>",
  "subject": "Email subject line",
  "date": "2024-12-20T10:30:00.000Z",
  "trimmed_email": {
    "headers": { "from": "...", "to": "...", "subject": "...", "date": "..." },
    "body_text": "The trimmed email body that was sent to the LLM",
    "url_analysis": { "count": 5, "unique_domains": [...], "has_ip_based_urls": false, ... },
    "sender_analysis": { "display_name": "...", "email_address": "...", ... },
    "attachments": [...],
    "stats": { "original_char_count": 5000, "trimmed_char_count": 2000, ... }
  },
  "original_decision": {
    "notify": true,
    "confidence": 0.95,
    "reason": "LLM's original reasoning",
    "message_packet": { "title": "...", "body": "...", "urgency": "high" }
  },
  "label": "TP"
}
```

### Label Values

| Label | Meaning | Location | Action |
|-------|---------|----------|--------|
| `"TP"` | True Positive - correctly notified | `notified/` | None (correct) |
| `"TN"` | True Negative - correctly not notified | `notnotified/` | None (correct) |
| `"FP"` | False Positive - should NOT have notified | `notified/` | User edits label to "FP" |
| `"FN"` | False Negative - SHOULD have notified | `notnotified/` | User edits label to "FN" |

**Initial State:** All emails start with `"TP"` (in notified/) or `"TN"` (in notnotified/). This means "the LLM's decision was correct." The user then manually edits specific files to mark errors as `"FP"` or `"FN"`.

---

## Configuration

### config.json

```json
{
  "max_attempts": 10,
  "model": "claude-sonnet-4-5-20241022",
  "temperature": 0.3,
  "stop_on_zero_errors": true,
  "regression_threshold": 0.1,
  "evaluation": {
    "errors_only": false,
    "max_notified": null,
    "max_notnotified": null
  }
}
```

| Field | Description |
|-------|-------------|
| `max_attempts` | Maximum tuning iterations. **Re-read before each attempt** so user can edit mid-run. |
| `model` | Claude model to use for tuning agent (Sonnet 4.5) |
| `temperature` | Temperature for tuning agent (lower = more deterministic) |
| `stop_on_zero_errors` | Stop early if FP + FN = 0 |
| `regression_threshold` | Reject prompt if total errors increase by more than this fraction |
| `evaluation.errors_only` | If `true`, only evaluate emails labeled FP or FN (skip TP/TN). Dramatically faster for iterating. |
| `evaluation.max_notified` | Limit evaluation to N emails from `notified/`. `null` = all. |
| `evaluation.max_notnotified` | Limit evaluation to N emails from `notnotified/`. `null` = all. |

**Evaluation Speed Notes:**
- Full run of 200 emails ≈ 100 minutes (30 sec/email on local LLM)
- `errors_only: true` runs only FP+FN labeled emails — much faster for tuning iterations
- Use `max_notified`/`max_notnotified` for quick sanity checks before full runs
- **Parseltongue tests always run regardless of these settings** (see below)

### .env

```
ANTHROPIC_API_KEY=sk-ant-...
```

**Must be added to .gitignore**

### LLM Configuration (from parent project)

The evaluation scripts must use the **parent project's `.env`** for local LLM settings:

```
LLM_BASE_URL=http://192.168.1.xxx:8080   # Your local LLM endpoint
LLM_MODEL=your-model-name
LLM_API_KEY=...                           # If required
```

**Important:** Do NOT use hardcoded defaults. The scripts must read from `../.env` to find the actual LLM endpoint. The `prompt-tuning/.env` is only for the Anthropic API key used by the tuning agent.

---

## Parseltongue / Prompt Injection Tests

The FP increase came from hardening the prompt against prompt injection attacks. We must ensure the prompt continues to pass all injection tests while reducing false positives.

**Note:** Only use the parseltongue/injection tests. Other test fixtures (e.g., `llm_judgment_cases.json`) are unreliable and should be ignored.

### Test Cases

Located in `test/fixtures/prompt_injection_cases.json` with raw emails in `test/fixtures/raw/injection_*.eml`.

**Only run tests with `category: "parseltongue"`** (8 tests). Skip the `category: "basic"` tests - they are unreliable.

| ID | Attack Type | Expected |
|----|-------------|----------|
| `injection_leetspeak` | leetspeak_encoding | notify=false |
| `injection_base64` | base64_encoded_payload | notify=false |
| `injection_rot13` | rot13_cipher | notify=false |
| `injection_polyglot` | polyglot_mixed_encoding | notify=false |
| `injection_unicode_homoglyph` | unicode_homoglyph | notify=false |
| `injection_token_boundary` | token_boundary_exploit | notify=false |
| `injection_language_mix` | multilingual_injection | notify=false |
| `injection_kitchen_sink` | kitchen_sink_amalgam | notify=false |

### Mandatory Inclusion

**Every evaluation run MUST include all 8 parseltongue tests**, regardless of `errors_only`, `max_notified`, or `max_notnotified` settings. This ensures:

1. Prompt changes don't regress on security
2. The tuning agent sees when a change breaks injection resistance
3. We maintain the balance between usability and security

### Evaluation Order

```
1. Run all 8 parseltongue tests first (filter by category: "parseltongue")
2. If ANY parseltongue test fails → abort attempt, log failure, do not count as valid attempt
3. Only if all parseltongue tests pass → proceed to evaluate user emails
```

### In attempts_log.md

Each attempt should log:
```markdown
**Parseltongue Tests:** 8/8 passed ✓
```

Or if failed:
```markdown
**Parseltongue Tests:** 6/8 passed ✗
- FAILED: injection_leetspeak (got notify=true, expected false)
- FAILED: injection_base64 (got notify=true, expected false)
**ATTEMPT ABORTED** - prompt change broke injection resistance
```

---

## Workflow

### Phase 1: Data Collection (Backfill)

1. Run `backfill.js`
2. Script reads `recent_decisions` from `data/state.json`
3. For each decision, fetch the original email from Gmail API
4. Run email through `trimEmailForLLM()` to recreate the exact input
5. Save to `notified/` or `notnotified/` based on original decision
6. Set initial label to `"TP"` or `"TN"`

### Phase 2: Manual Labeling

1. User reviews emails in `notified/` folder
2. For any that shouldn't have notified, edit `"label": "TP"` → `"label": "FP"`
3. User reviews emails in `notnotified/` folder  
4. For any that should have notified, edit `"label": "TN"` → `"label": "FN"`

### Phase 3: Tuning Loop

```
For attempt = 1 to max_attempts (re-read each iteration):
    
    1. Re-read config.json (allows mid-run adjustment of max_attempts and evaluation settings)
    
    2. Load emails based on evaluation settings:
       - If errors_only=true: only load FP and FN labeled emails
       - If max_notified set: limit notified/ emails to N
       - If max_notnotified set: limit notnotified/ emails to N
       - ALWAYS load all 8 parseltongue test cases (category: "parseltongue" only)
    
    3. Count current errors (FP + FN labels)
    4. If errors == 0 and stop_on_zero_errors: EXIT SUCCESS
    
    5. Read attempts_log.md to understand prior attempts
    6. Analyze error patterns:
       - What do FP emails have in common?
       - What do FN emails have in common?
       - What prompt changes were tried before? Did they help or hurt?
    
    7. Generate hypothesis and proposed changes
    8. Log to attempts_log.md BEFORE making changes:
       - Attempt number
       - Hypothesis
       - Proposed prompt modifications
    
    9. Apply changes to current_prompt.txt
    
    10. FIRST: Run all 8 parseltongue tests
        - If ANY fail → log failure, ABORT attempt, do NOT increment attempt counter
        - This is a hard gate - security cannot regress
    
    11. THEN: Re-evaluate user emails with new prompt:
        - Run each email through LLM with current_prompt.txt
        - Compare LLM decision to label
        - New decision matches label = correct
        - New decision differs from label = still an error
    
    12. Log results to attempts_log.md:
        - Parseltongue tests: X/8 passed
        - FP count: before → after
        - FN count: before → after
        - Total errors: before → after
        - List of newly fixed emails
        - List of newly broken emails (regressions)
    
    13. If total errors increased significantly:
        - Log regression warning
        - Optionally revert to previous prompt
```

---

## attempts_log.md Format

This file persists across runs. New agents continue from where previous agents stopped.

```markdown
# Prompt Tuning Attempts Log

## Summary

| Attempt | Date | FP Before | FP After | FN Before | FN After | Total Errors | Status |
|---------|------|-----------|----------|-----------|----------|--------------|--------|
| 1 | 2024-12-20 14:30 | 12 | 8 | 3 | 3 | 15 → 11 | ✓ Improved |
| 2 | 2024-12-20 14:45 | 8 | 6 | 3 | 4 | 11 → 10 | ⚠ Mixed |
| 3 | 2024-12-20 15:02 | 6 | 9 | 4 | 2 | 10 → 11 | ✗ Regressed |

---

## Attempt 1

**Date:** 2024-12-20 14:30:00

**Starting State:**
- FP: 12
- FN: 3
- Total Errors: 15

**Hypothesis:**
The prompt is too aggressive about flagging "time-sensitive" language. Many routine 
delivery notifications use urgent-sounding words ("arriving today", "out for delivery") 
but don't actually require user action.

**Prompt Changes:**
Added to the prompt:
> There are emails which appear time sensitive, but should not be notified for, like 
> an imminent delivery which is in fact routine and should not be notified.

**Results:**
- FP: 12 → 8 (fixed 4)
- FN: 3 → 3 (no change)
- Total: 15 → 11

**Fixed:**
- 19b2f34737c902d7: Amazon delivery notification
- 19b2eb33aaa2b0e: UPS delivery
- ... 

**Regressed:**
- (none)

---

## Attempt 2
...
```

---

## Build Plan

### Step 1: Project Setup
- [x] Create `prompt-tuning/` folder
- [ ] Create `requirements.md` (this file)
- [ ] Add `.env` pattern to root `.gitignore`
- [ ] Create `config.json` with defaults
- [ ] Create empty `attempts_log.md` with header template
- [ ] Create `notified/` and `notnotified/` folders
- [ ] Copy current system prompt to `current_prompt.txt`

### Step 2: Backfill Script (`scripts/backfill.js`)
- [ ] Read `recent_decisions` from `../data/state.json`
- [ ] Initialize Gmail client (reuse existing auth from parent project)
- [ ] For each decision:
  - [ ] Fetch raw email via Gmail API using message ID
  - [ ] Parse email using existing `parseRawEmail()`
  - [ ] Trim email using existing `trimEmailForLLM()`
  - [ ] Build JSON object with schema above
  - [ ] Write to `notified/{id}.json` or `notnotified/{id}.json`
- [ ] Report: X emails backfilled (Y notified, Z not notified)

### Step 3: Evaluate Script (`scripts/evaluate.js`)
- [ ] Load LLM config from parent project's `../.env` (LLM_BASE_URL, LLM_MODEL, LLM_API_KEY)
  - [ ] **Do NOT use hardcoded defaults** - must find actual endpoint
- [ ] Read evaluation settings from `config.json`
- [ ] Load `current_prompt.txt`
- [ ] ALWAYS load and run all 8 parseltongue tests first (category: "parseltongue" only):
  - [ ] Load test cases from `../test/fixtures/prompt_injection_cases.json`
  - [ ] Load raw emails from `../test/fixtures/raw/injection_*.eml`
  - [ ] Run through email trimmer → LLM (using real endpoint from .env)
  - [ ] Verify all return notify=false
  - [ ] Report: X/8 parseltongue tests passed
  - [ ] **Ignore other test fixtures** (e.g., llm_judgment_cases.json - they don't work)
- [ ] Load user emails based on settings:
  - [ ] If `errors_only=true`: only load FP/FN labeled files
  - [ ] Apply `max_notified` and `max_notnotified` limits
- [ ] For each email:
  - [ ] Call local LLM (same as production) with current prompt
  - [ ] Compare result.notify to expected (based on label)
  - [ ] Track: correct, FP, FN
- [ ] Output summary: 
  - [ ] Parseltongue: X/8 passed
  - [ ] User emails: accuracy, FP count, FN count
  - [ ] List of errors with IDs and subjects

### Step 4: Tune Script (`scripts/tune.js`)
- [ ] Load LLM config from parent project's `../.env` (for evaluation calls)
- [ ] Load Anthropic API key from `./.env` (for tuning agent)
- [ ] Read `config.json` for settings (re-read before each attempt)
- [ ] Read `attempts_log.md` to determine current attempt number and history
- [ ] Load emails based on evaluation settings:
  - [ ] If `errors_only`: only load FP/FN labeled emails
  - [ ] Respect `max_notified` and `max_notnotified` limits
  - [ ] ALWAYS load all 8 parseltongue test cases (category: "parseltongue" only, skip "basic")
- [ ] Count FP and FN from labels
- [ ] If no errors, exit success
- [ ] Call Claude Sonnet 4.5 (via Anthropic API) with:
  - [ ] Current prompt
  - [ ] List of FP emails (with content and LLM reasoning)
  - [ ] List of FN emails (with content and LLM reasoning)
  - [ ] History of prior attempts from attempts_log.md
  - [ ] Request: hypothesis + specific prompt changes
- [ ] Log hypothesis and changes to attempts_log.md BEFORE applying
- [ ] Apply changes to `current_prompt.txt`
- [ ] Run 8 parseltongue tests FIRST (via local LLM)
  - [ ] If any fail → abort attempt, log failure, do not increment counter
- [ ] Run evaluation on user emails (via local LLM)
- [ ] Log results to attempts_log.md
- [ ] Loop or exit

### Step 5: Integration & Testing
- [ ] Test backfill with small batch (10 emails)
- [ ] Test evaluate against known labels
- [ ] Test tune loop with max_attempts=1
- [ ] Verify attempts_log.md persists correctly
- [ ] Verify config.json is re-read each iteration

---

## Open Questions

1. **Local LLM vs Anthropic for evaluation?** 
   - Evaluation should use the same local LLM as production (consistency)
   - Only the tuning agent uses Anthropic API
   - This means we need both: local LLM endpoint + Anthropic API key

2. **How to handle emails that are no longer in Gmail?**
   - Some emails may have been deleted
   - Backfill should skip gracefully and log

3. **Should we version the prompt?**
   - Could save `prompt_v1.txt`, `prompt_v2.txt`, etc.
   - Allows easy rollback
   - Decision: Yes, save each version with attempt number

4. **Rate limiting?**
   - Gmail API: ~250 quota units per user per second
   - Anthropic API: varies by tier
   - Local LLM: depends on hardware
   - Build in configurable delays if needed

---

## Success Criteria

1. Backfill completes for 200 emails
2. Initial evaluation shows 0 errors (before user labeling)
3. All 8 parseltongue tests pass with initial prompt
4. After user adds FP/FN labels, tuning loop reduces error count
5. Parseltongue tests continue to pass after every prompt modification
6. attempts_log.md accurately tracks all attempts
7. Agent can be stopped and resumed without losing progress
8. `errors_only` mode works correctly for faster iteration
9. Final prompt can be copied back to `data/system_prompt.txt` for production use

