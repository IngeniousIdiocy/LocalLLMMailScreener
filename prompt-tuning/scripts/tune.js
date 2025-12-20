#!/usr/bin/env node
/**
 * Tune Script
 * 
 * Main tuning agent loop that uses Claude Sonnet 4.5 to analyze errors
 * and propose prompt modifications.
 * 
 * Usage:
 *   node scripts/tune.js               # Run tuning loop
 *   node scripts/tune.js --dry-run     # Show what would be done
 *   node scripts/tune.js --once        # Single iteration only
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const tuningRoot = path.resolve(__dirname, '..');

// Load parent project's .env for LLM config
loadEnv({ path: path.join(projectRoot, '.env') });

// Load tuning project's .env for Anthropic API key
loadEnv({ path: path.join(tuningRoot, '.env'), override: true });

// Import from parent project
import { callLLM } from '../../src/llm.js';
import { trimEmailForLLM } from '../../src/email_trim.js';

const parseArgs = () => {
  const args = {
    dryRun: false,
    once: false,
    verbose: false
  };
  
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--once') args.once = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
  }
  
  return args;
};

const loadConfig = () => {
  const configPath = path.join(tuningRoot, 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
};

const buildLLMConfig = () => {
  const env = process.env;
  
  if (!env.LLM_BASE_URL) {
    throw new Error('LLM_BASE_URL not set in ../.env - cannot find LLM endpoint');
  }
  
  return {
    llmBaseUrl: env.LLM_BASE_URL,
    llmModel: env.LLM_MODEL || 'local-model',
    llmTemperature: parseFloat(env.LLM_TEMPERATURE || '0.2'),
    llmMaxOutputTokens: parseInt(env.LLM_MAX_OUTPUT_TOKENS || '300', 10),
    llmTimeoutMs: parseInt(env.LLM_TIMEOUT_MS || '120000', 10),
    llmApiKey: env.LLM_API_KEY || '',
    maxSmsChars: parseInt(env.MAX_SMS_CHARS || '900', 10),
    maxEmailBodyChars: parseInt(env.MAX_EMAIL_BODY_CHARS || '4000', 10)
  };
};

// Load parseltongue test cases (category: "parseltongue" only)
const loadParseltongueTests = () => {
  const casesPath = path.join(projectRoot, 'test', 'fixtures', 'prompt_injection_cases.json');
  const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  return allCases.filter(c => c.category === 'parseltongue');
};

// Load raw .eml file and parse it
const loadAndParseEml = async (rawFile) => {
  const fullPath = path.join(projectRoot, 'test', 'fixtures', rawFile);
  const rawEmail = fs.readFileSync(fullPath, 'utf8');
  const parsed = await simpleParser(rawEmail);
  
  let bodyText = parsed.text || '';
  if (!bodyText && parsed.html) {
    bodyText = convert(parsed.html, { wordwrap: false });
  }
  
  return {
    message_id: path.basename(rawFile, '.eml'),
    thread_id: `t-${path.basename(rawFile, '.eml')}`,
    gmail_link: '',
    date: parsed.date ? parsed.date.toISOString() : '',
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    cc: parsed.cc?.text || '',
    subject: parsed.subject || '',
    body_text: bodyText,
    attachments: (parsed.attachments || []).map(att => ({
      filename: att.filename,
      contentType: att.contentType,
      size: att.size
    }))
  };
};

// Load user emails from notified/ and notnotified/ folders
const loadUserEmails = (evalConfig) => {
  const notifiedDir = path.join(tuningRoot, 'notified');
  const notnotifiedDir = path.join(tuningRoot, 'notnotified');
  
  const loadFromDir = (dir, expectedNotify) => {
    if (!fs.existsSync(dir)) return [];
    
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const loaded = [];
    
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const label = data.label || (expectedNotify ? 'TP' : 'TN');
      let shouldNotify;
      
      if (expectedNotify) {
        shouldNotify = label !== 'FP';
      } else {
        shouldNotify = label === 'FN';
      }
      
      loaded.push({
        id: data.id,
        from: data.from,
        subject: data.subject,
        label: label,
        shouldNotify: shouldNotify,
        trimmedEmail: data.trimmed_email,
        originalDecision: data.original_decision
      });
    }
    
    return loaded;
  };
  
  let notifiedEmails = loadFromDir(notifiedDir, true);
  let notnotifiedEmails = loadFromDir(notnotifiedDir, false);
  
  // Split by label type
  const byLabel = {
    FP: notifiedEmails.filter(e => e.label === 'FP'),
    TP: notifiedEmails.filter(e => e.label === 'TP'),
    FN: notnotifiedEmails.filter(e => e.label === 'FN'),
    TN: notnotifiedEmails.filter(e => e.label === 'TN')
  };
  
  // Apply errors_only filter (only FP and FN)
  if (evalConfig.errors_only) {
    return [...byLabel.FP, ...byLabel.FN];
  }
  
  // Apply per-label limits
  const result = [];
  
  if (evalConfig.max_fp !== undefined && evalConfig.max_fp !== null) {
    result.push(...byLabel.FP.slice(0, evalConfig.max_fp));
  } else {
    result.push(...byLabel.FP);
  }
  
  if (evalConfig.max_tp !== undefined && evalConfig.max_tp !== null) {
    result.push(...byLabel.TP.slice(0, evalConfig.max_tp));
  } else {
    result.push(...byLabel.TP);
  }
  
  if (evalConfig.max_fn !== undefined && evalConfig.max_fn !== null) {
    result.push(...byLabel.FN.slice(0, evalConfig.max_fn));
  } else {
    result.push(...byLabel.FN);
  }
  
  if (evalConfig.max_tn !== undefined && evalConfig.max_tn !== null) {
    result.push(...byLabel.TN.slice(0, evalConfig.max_tn));
  } else {
    result.push(...byLabel.TN);
  }
  
  return result;
};

// Run a single email through the LLM
const evaluateEmail = async (emailObj, llmConfig, promptPath) => {
  try {
    const result = await callLLM({
      llmBaseUrl: llmConfig.llmBaseUrl,
      apiKey: llmConfig.llmApiKey,
      model: llmConfig.llmModel,
      temperature: llmConfig.llmTemperature,
      maxOutputTokens: llmConfig.llmMaxOutputTokens,
      timeoutMs: llmConfig.llmTimeoutMs,
      emailObj: emailObj,
      maxSmsChars: llmConfig.maxSmsChars,
      systemPromptPath: promptPath
    });
    
    return {
      notify: result.parsed?.notify === true,
      reason: result.parsed?.reason,
      error: null
    };
  } catch (err) {
    return { notify: null, reason: null, error: err.message };
  }
};

// Run all parseltongue tests
const runParseltongueTests = async (llmConfig, promptPath) => {
  const tests = loadParseltongueTests();
  const results = [];
  
  for (const testCase of tests) {
    const emailObj = await loadAndParseEml(testCase.raw_file);
    const trimmedEmail = trimEmailForLLM(emailObj, { maxBodyChars: llmConfig.maxEmailBodyChars });
    const result = await evaluateEmail(trimmedEmail, llmConfig, promptPath);
    
    results.push({
      id: testCase.id,
      passed: result.notify === false,
      notify: result.notify,
      error: result.error
    });
  }
  
  return results;
};

// Run all user email evaluations
const runUserEvaluations = async (emails, llmConfig, promptPath) => {
  const results = [];
  
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    console.log(`  [${i + 1}/${emails.length}] ${email.id}...`);
    
    const result = await evaluateEmail(email.trimmedEmail, llmConfig, promptPath);
    const correct = result.notify === email.shouldNotify;
    
    results.push({
      id: email.id,
      label: email.label,
      subject: email.subject,
      from: email.from,
      shouldNotify: email.shouldNotify,
      gotNotify: result.notify,
      reason: result.reason,
      correct,
      error: result.error
    });
  }
  
  return results;
};

// Parse attempts_log.md to get current attempt number and history
const parseAttemptsLog = () => {
  const logPath = path.join(tuningRoot, 'attempts_log.md');
  const content = fs.readFileSync(logPath, 'utf8');
  
  // Count attempts by looking for "## Attempt N" headers
  const attemptMatches = content.match(/## Attempt \d+/g) || [];
  const currentAttempt = attemptMatches.length;
  
  return { currentAttempt, fullLog: content };
};

// Append to attempts_log.md
const appendToLog = (content) => {
  const logPath = path.join(tuningRoot, 'attempts_log.md');
  fs.appendFileSync(logPath, content);
};

// Update summary table in attempts_log.md
const updateSummaryTable = (attemptNum, date, parseltongue, fpBefore, fpAfter, fnBefore, fnAfter, status) => {
  const logPath = path.join(tuningRoot, 'attempts_log.md');
  let content = fs.readFileSync(logPath, 'utf8');
  
  const totalBefore = fpBefore + fnBefore;
  const totalAfter = fpAfter + fnAfter;
  const newRow = `| ${attemptNum} | ${date} | ${parseltongue} | ${fpBefore} | ${fpAfter} | ${fnBefore} | ${fnAfter} | ${totalBefore} → ${totalAfter} | ${status} |`;
  
  // Find the end of the summary table (line before the first ---)
  const lines = content.split('\n');
  let insertIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('---') && i > 5) {
      insertIndex = i;
      break;
    }
  }
  
  if (insertIndex > 0) {
    lines.splice(insertIndex, 0, newRow);
    fs.writeFileSync(logPath, lines.join('\n'));
  }
};

// Call Claude Sonnet 4.5 to analyze errors and propose changes
const callTuningAgent = async (anthropic, config, currentPrompt, fpEmails, fnEmails, attemptsLog) => {
  const systemPrompt = `You are a prompt engineering expert helping tune a system prompt for an email triage LLM.

The LLM receives emails and must decide whether to send a notification (notify=true) or not (notify=false).

CURRENT ISSUES:
- False Positives (FP): Emails that were notified but SHOULD NOT have been
- False Negatives (FN): Emails that were NOT notified but SHOULD have been

Your task:
1. Analyze the error patterns in the FP and FN emails
2. Form a hypothesis about why the LLM is making these mistakes
3. Propose SPECIFIC, TARGETED changes to the system prompt

IMPORTANT CONSTRAINTS:
- The prompt must still pass all parseltongue/prompt injection tests (all must return notify=false)
- Changes should be minimal and focused
- Prefer adding clarifying rules over removing security measures
- Consider edge cases that might cause regressions

Output your analysis in this exact format:
---HYPOTHESIS---
[Your hypothesis about why the LLM is making these errors]

---CHANGES---
[Describe the specific changes you're making to the prompt]

---NEW_PROMPT---
[The complete new prompt text]
---END---`;

  const fpSummary = fpEmails.map(e => `
FP: ${e.id}
From: ${e.from}
Subject: ${e.subject}
LLM Reason: ${e.reason || 'N/A'}
Body preview: ${e.trimmedEmail?.body_text?.substring(0, 300) || 'N/A'}...
`).join('\n');

  const fnSummary = fnEmails.map(e => `
FN: ${e.id}
From: ${e.from}
Subject: ${e.subject}
LLM Reason: ${e.reason || 'N/A'}
Body preview: ${e.trimmedEmail?.body_text?.substring(0, 300) || 'N/A'}...
`).join('\n');

  const userMessage = `## Current System Prompt:
\`\`\`
${currentPrompt}
\`\`\`

## Previous Attempts:
${attemptsLog}

## Current Errors (${fpEmails.length} FP, ${fnEmails.length} FN):

### False Positives (should NOT have notified):
${fpSummary || '(none)'}

### False Negatives (SHOULD have notified):
${fnSummary || '(none)'}

Please analyze these errors and propose changes to the system prompt.`;

  const response = await anthropic.messages.create({
    model: config.model,
    max_tokens: 4096,
    temperature: config.temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  const content = response.content[0].text;
  
  // Parse the response
  const hypothesisMatch = content.match(/---HYPOTHESIS---\n([\s\S]*?)\n---CHANGES---/);
  const changesMatch = content.match(/---CHANGES---\n([\s\S]*?)\n---NEW_PROMPT---/);
  const promptMatch = content.match(/---NEW_PROMPT---\n([\s\S]*?)\n---END---/);
  
  return {
    hypothesis: hypothesisMatch ? hypothesisMatch[1].trim() : 'Unable to parse hypothesis',
    changes: changesMatch ? changesMatch[1].trim() : 'Unable to parse changes',
    newPrompt: promptMatch ? promptMatch[1].trim() : null,
    rawResponse: content
  };
};

const main = async () => {
  const args = parseArgs();
  
  console.log('='.repeat(70));
  console.log('TUNE: Prompt Tuning Agent');
  console.log('='.repeat(70));
  
  // Check for Anthropic API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set in prompt-tuning/.env');
    process.exit(1);
  }
  
  const anthropic = new Anthropic();
  
  // Load configs
  let config = loadConfig();
  const llmConfig = buildLLMConfig();
  
  console.log(`\nLocal LLM: ${llmConfig.llmBaseUrl}`);
  console.log(`Tuning model: ${config.model}`);
  console.log(`Max attempts: ${config.max_attempts}`);
  
  const promptPath = path.join(tuningRoot, 'current_prompt.txt');
  
  // Main tuning loop
  while (true) {
    // Re-read config each iteration (allows mid-run adjustment)
    config = loadConfig();
    const evalConfig = config.evaluation || {};
    
    const { currentAttempt, fullLog } = parseAttemptsLog();
    const nextAttempt = currentAttempt + 1;
    
    if (nextAttempt > config.max_attempts) {
      console.log(`\n✓ Reached max_attempts (${config.max_attempts}). Stopping.`);
      break;
    }
    
    console.log('\n' + '-'.repeat(70));
    console.log(`ATTEMPT ${nextAttempt}`);
    console.log('-'.repeat(70));
    
    // Load current prompt
    const currentPrompt = fs.readFileSync(promptPath, 'utf8');
    
    // Load user emails
    const userEmails = loadUserEmails(evalConfig);
    const fpEmails = userEmails.filter(e => e.label === 'FP');
    const fnEmails = userEmails.filter(e => e.label === 'FN');
    
    console.log(`Loaded ${userEmails.length} user emails (${fpEmails.length} FP, ${fnEmails.length} FN)`);
    
    // Check if there are any errors to fix
    if (fpEmails.length === 0 && fnEmails.length === 0) {
      if (config.stop_on_zero_errors) {
        console.log('\n✓ No errors (FP/FN) found. Nothing to tune!');
        break;
      }
    }
    
    if (args.dryRun) {
      console.log('\nDRY-RUN: Would call tuning agent with:');
      console.log(`  FP emails: ${fpEmails.length}`);
      console.log(`  FN emails: ${fnEmails.length}`);
      break;
    }
    
    // Call tuning agent
    console.log('\nCalling Claude Sonnet 4.5 for analysis...');
    
    let agentResponse;
    try {
      // For the agent, we need to run evaluations first to get the reasons
      console.log('Running pre-evaluation to get LLM reasons...');
      const preResults = await runUserEvaluations(
        [...fpEmails, ...fnEmails].slice(0, 20), // Limit for speed
        llmConfig, 
        promptPath
      );
      
      // Merge reasons back into emails
      for (const result of preResults) {
        const email = [...fpEmails, ...fnEmails].find(e => e.id === result.id);
        if (email) email.reason = result.reason;
      }
      
      agentResponse = await callTuningAgent(
        anthropic, 
        config, 
        currentPrompt, 
        fpEmails, 
        fnEmails, 
        fullLog
      );
    } catch (err) {
      console.error(`\n❌ Tuning agent error: ${err.message}`);
      break;
    }
    
    if (!agentResponse.newPrompt) {
      console.error('\n❌ Agent did not return a valid new prompt');
      console.log('Raw response:', agentResponse.rawResponse?.substring(0, 500));
      break;
    }
    
    // Log hypothesis and changes BEFORE applying
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0] + ' ' + now.toTimeString().split(' ')[0].substring(0, 5);
    
    const preLogEntry = `
## Attempt ${nextAttempt}

**Date:** ${now.toISOString()}

**Starting State:**
- FP: ${fpEmails.length}
- FN: ${fnEmails.length}
- Total Errors: ${fpEmails.length + fnEmails.length}

**Hypothesis:**
${agentResponse.hypothesis}

**Prompt Changes:**
${agentResponse.changes}

`;
    
    appendToLog(preLogEntry);
    console.log('\n📝 Logged hypothesis and changes to attempts_log.md');
    
    // Save previous prompt version
    const versionPath = path.join(tuningRoot, `prompt_v${nextAttempt - 1}.txt`);
    fs.writeFileSync(versionPath, currentPrompt);
    console.log(`💾 Saved previous prompt to prompt_v${nextAttempt - 1}.txt`);
    
    // Apply new prompt
    fs.writeFileSync(promptPath, agentResponse.newPrompt);
    console.log('✏️  Applied new prompt to current_prompt.txt');
    
    // Run parseltongue tests FIRST
    console.log('\n🔒 Running parseltongue tests...');
    const parseltongueResults = await runParseltongueTests(llmConfig, promptPath);
    const parseltonguePass = parseltongueResults.filter(r => r.passed).length;
    const parseltongueFail = parseltongueResults.filter(r => !r.passed).length;
    
    console.log(`Parseltongue: ${parseltonguePass}/8 passed`);
    
    if (parseltongueFail > 0) {
      console.log('\n❌ PARSELTONGUE FAILURE - Reverting prompt');
      
      // Revert to previous prompt
      fs.writeFileSync(promptPath, currentPrompt);
      
      const failLog = `
**Parseltongue Tests:** ${parseltonguePass}/8 passed ✗
${parseltongueResults.filter(r => !r.passed).map(r => `- FAILED: ${r.id}`).join('\n')}

**ATTEMPT ABORTED** - prompt change broke injection resistance

---
`;
      appendToLog(failLog);
      
      // Don't count this as an attempt, continue to next iteration
      continue;
    }
    
    // Run user email evaluations
    console.log('\n📧 Evaluating user emails...');
    const userResults = await runUserEvaluations(userEmails, llmConfig, promptPath);
    
    const newFP = userResults.filter(r => r.gotNotify === true && r.shouldNotify === false).length;
    const newFN = userResults.filter(r => r.gotNotify === false && r.shouldNotify === true).length;
    const totalErrors = newFP + newFN;
    const prevErrors = fpEmails.length + fnEmails.length;
    
    // Determine status
    let status;
    if (totalErrors < prevErrors) {
      status = '✓ Improved';
    } else if (totalErrors > prevErrors) {
      status = '✗ Regressed';
    } else {
      status = '⚠ No change';
    }
    
    // Log results
    const resultsLog = `
**Parseltongue Tests:** ${parseltonguePass}/8 passed ✓

**Results:**
- FP: ${fpEmails.length} → ${newFP}
- FN: ${fnEmails.length} → ${newFN}
- Total: ${prevErrors} → ${totalErrors}

**Status:** ${status}

**Fixed:**
${userResults.filter(r => r.correct && (r.label === 'FP' || r.label === 'FN')).map(r => `- ${r.id}: ${r.subject?.substring(0, 40)}`).join('\n') || '- (none)'}

**Regressed:**
${userResults.filter(r => !r.correct && r.label !== 'FP' && r.label !== 'FN').map(r => `- ${r.id}: ${r.subject?.substring(0, 40)}`).join('\n') || '- (none)'}

---
`;
    
    appendToLog(resultsLog);
    
    // Update summary table
    updateSummaryTable(
      nextAttempt, dateStr, `${parseltonguePass}/8`,
      fpEmails.length, newFP, fnEmails.length, newFN, status
    );
    
    console.log('\n' + '-'.repeat(70));
    console.log(`ATTEMPT ${nextAttempt} COMPLETE`);
    console.log('-'.repeat(70));
    console.log(`Parseltongue: ${parseltonguePass}/8`);
    console.log(`FP: ${fpEmails.length} → ${newFP}`);
    console.log(`FN: ${fnEmails.length} → ${newFN}`);
    console.log(`Status: ${status}`);
    
    // Check if we should stop
    if (totalErrors === 0 && config.stop_on_zero_errors) {
      console.log('\n✓ Zero errors achieved! Stopping.');
      break;
    }
    
    if (args.once) {
      console.log('\n--once flag set. Stopping after single iteration.');
      break;
    }
    
    // Check regression threshold
    if (totalErrors > prevErrors * (1 + config.regression_threshold)) {
      console.log(`\n⚠️  Significant regression detected (>${config.regression_threshold * 100}% increase)`);
      console.log('Consider reverting to previous prompt version.');
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('TUNING COMPLETE');
  console.log('='.repeat(70));
  console.log(`\nResults logged to: attempts_log.md`);
  console.log(`Current prompt: current_prompt.txt`);
  console.log(`\nTo apply to production: cp current_prompt.txt ../data/system_prompt.txt`);
};

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

