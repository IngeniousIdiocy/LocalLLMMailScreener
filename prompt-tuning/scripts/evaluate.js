#!/usr/bin/env node
/**
 * Evaluate Script
 * 
 * Runs emails through the LLM with current_prompt.txt and reports accuracy.
 * Always runs parseltongue tests first as a hard gate.
 * 
 * Usage:
 *   node scripts/evaluate.js                    # Full evaluation
 *   node scripts/evaluate.js --errors-only      # Only FP/FN labeled emails
 *   node scripts/evaluate.js --parseltongue     # Only parseltongue tests
 *   node scripts/evaluate.js --dry-run          # Show what would be evaluated
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const tuningRoot = path.resolve(__dirname, '..');

// Load parent project's .env for LLM config
loadEnv({ path: path.join(projectRoot, '.env') });

// Import from parent project
import { callLLM, getSystemPrompt } from '../../src/llm.js';
import { trimEmailForLLM } from '../../src/email_trim.js';

const parseArgs = () => {
  const args = {
    errorsOnly: false,
    parseltongueOnly: false,
    dryRun: false,
    verbose: false
  };
  
  for (const arg of process.argv.slice(2)) {
    if (arg === '--errors-only') args.errorsOnly = true;
    else if (arg === '--parseltongue') args.parseltongueOnly = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') args.verbose = true;
  }
  
  return args;
};

const loadConfig = () => {
  const configPath = path.join(tuningRoot, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { evaluation: {} };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
};

const buildLLMConfig = () => {
  const env = process.env;
  
  // Validate LLM config exists
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
const loadUserEmails = (args, evalConfig) => {
  const notifiedDir = path.join(tuningRoot, 'notified');
  const notnotifiedDir = path.join(tuningRoot, 'notnotified');
  
  const loadFromDir = (dir, expectedNotify) => {
    if (!fs.existsSync(dir)) return [];
    
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const loaded = [];
    
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      
      // Determine expected result based on label
      // TP/FN in notified/ → should notify (TP=correct, FN=was wrong but should have)
      // TN/FP in notnotified/ → should not notify
      const label = data.label || (expectedNotify ? 'TP' : 'TN');
      let shouldNotify;
      
      if (expectedNotify) {
        // In notified/ folder
        shouldNotify = label !== 'FP';  // FP means should NOT have notified
      } else {
        // In notnotified/ folder
        shouldNotify = label === 'FN';  // FN means SHOULD have notified
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
  if (args.errorsOnly || evalConfig.errors_only) {
    return [...byLabel.FP, ...byLabel.FN];
  }
  
  // Apply per-label limits (new feature)
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
  
  // Fallback to old limits if no per-label limits set
  if (Object.keys(evalConfig).every(k => !k.startsWith('max_'))) {
    if (evalConfig.max_notified && notifiedEmails.length > evalConfig.max_notified) {
      notifiedEmails = notifiedEmails.slice(0, evalConfig.max_notified);
    }
    if (evalConfig.max_notnotified && notnotifiedEmails.length > evalConfig.max_notnotified) {
      notnotifiedEmails = notnotifiedEmails.slice(0, evalConfig.max_notnotified);
    }
    return [...notifiedEmails, ...notnotifiedEmails];
  }
  
  return result;
};

// Run a single email through the LLM
const evaluateEmail = async (emailObj, llmConfig, promptPath) => {
  const start = Date.now();
  
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
      confidence: result.parsed?.confidence,
      reason: result.parsed?.reason,
      latencyMs: Date.now() - start,
      error: null
    };
  } catch (err) {
    return {
      notify: null,
      confidence: null,
      reason: null,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
};

const main = async () => {
  const args = parseArgs();
  const config = loadConfig();
  const evalConfig = config.evaluation || {};
  
  console.log('='.repeat(70));
  console.log('EVALUATE: Testing prompt against emails');
  console.log('='.repeat(70));
  
  // Load LLM config
  let llmConfig;
  try {
    llmConfig = buildLLMConfig();
    console.log(`\nLLM endpoint: ${llmConfig.llmBaseUrl}`);
    console.log(`Model: ${llmConfig.llmModel}`);
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  }
  
  const promptPath = path.join(tuningRoot, 'current_prompt.txt');
  if (!fs.existsSync(promptPath)) {
    console.error(`\n❌ current_prompt.txt not found`);
    process.exit(1);
  }
  console.log(`Prompt: ${promptPath}`);
  
  // ===== PARSELTONGUE TESTS (always run first) =====
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 1: Parseltongue Tests (8 tests)');
  console.log('-'.repeat(70));
  
  const parseltongueTests = loadParseltongueTests();
  console.log(`Loaded ${parseltongueTests.length} parseltongue test cases`);
  
  const parseltongueResults = [];
  
  for (let i = 0; i < parseltongueTests.length; i++) {
    const testCase = parseltongueTests[i];
    console.log(`\n[${i + 1}/${parseltongueTests.length}] ${testCase.id}`);
    
    if (args.dryRun) {
      console.log(`  Would test: ${testCase.attack_type}`);
      continue;
    }
    
    // Load and parse the .eml file
    const emailObj = await loadAndParseEml(testCase.raw_file);
    const trimmedEmail = trimEmailForLLM(emailObj, { maxBodyChars: llmConfig.maxEmailBodyChars });
    
    const result = await evaluateEmail(trimmedEmail, llmConfig, promptPath);
    
    const passed = result.notify === false;  // All parseltongue tests expect notify=false
    parseltongueResults.push({
      id: testCase.id,
      attackType: testCase.attack_type,
      passed,
      notify: result.notify,
      error: result.error,
      latencyMs: result.latencyMs
    });
    
    if (passed) {
      console.log(`  ✓ PASS (notify=${result.notify}, ${result.latencyMs}ms)`);
    } else {
      console.log(`  ✗ FAIL (notify=${result.notify}, expected=false)`);
      if (result.error) console.log(`    Error: ${result.error}`);
    }
  }
  
  const parseltonguePassCount = parseltongueResults.filter(r => r.passed).length;
  const parseltongueFailCount = parseltongueResults.filter(r => !r.passed).length;
  
  console.log('\n' + '-'.repeat(70));
  console.log(`Parseltongue Results: ${parseltonguePassCount}/${parseltongueResults.length} passed`);
  
  if (parseltongueFailCount > 0) {
    console.log('\n⚠️  PARSELTONGUE FAILURES:');
    parseltongueResults.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.id}: ${r.attackType}`);
    });
  }
  
  // If parseltongue-only mode, stop here
  if (args.parseltongueOnly) {
    console.log('\n' + '='.repeat(70));
    console.log('PARSELTONGUE-ONLY MODE - Skipping user emails');
    console.log('='.repeat(70));
    process.exit(parseltongueFailCount > 0 ? 1 : 0);
  }
  
  // Check if parseltongue is a hard gate
  if (parseltongueFailCount > 0 && !args.dryRun) {
    console.log('\n❌ EVALUATION ABORTED: Parseltongue tests must pass before evaluating user emails');
    process.exit(1);
  }
  
  // ===== USER EMAILS =====
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 2: User Emails');
  console.log('-'.repeat(70));
  
  const userEmails = loadUserEmails(args, evalConfig);
  
  if (userEmails.length === 0) {
    console.log('No user emails found. Run backfill.js first.');
    console.log('\n' + '='.repeat(70));
    console.log('EVALUATION COMPLETE');
    console.log('='.repeat(70));
    console.log(`Parseltongue: ${parseltonguePassCount}/8 passed`);
    console.log('User emails: 0 (none loaded)');
    process.exit(0);
  }
  
  const fpEmails = userEmails.filter(e => e.label === 'FP').length;
  const fnEmails = userEmails.filter(e => e.label === 'FN').length;
  console.log(`Loaded ${userEmails.length} user emails`);
  console.log(`  FP labeled: ${fpEmails}`);
  console.log(`  FN labeled: ${fnEmails}`);
  
  if (args.dryRun) {
    console.log('\nDRY-RUN: Would evaluate these emails');
    userEmails.forEach(e => {
      console.log(`  ${e.id}: ${e.subject?.substring(0, 50)}... (${e.label})`);
    });
    process.exit(0);
  }
  
  const userResults = [];
  
  for (let i = 0; i < userEmails.length; i++) {
    const email = userEmails[i];
    console.log(`\n[${i + 1}/${userEmails.length}] ${email.id}`);
    console.log(`  Subject: ${email.subject?.substring(0, 50)}...`);
    console.log(`  Label: ${email.label}, Expected notify: ${email.shouldNotify}`);
    
    const result = await evaluateEmail(email.trimmedEmail, llmConfig, promptPath);
    
    const correct = result.notify === email.shouldNotify;
    userResults.push({
      id: email.id,
      label: email.label,
      shouldNotify: email.shouldNotify,
      gotNotify: result.notify,
      correct,
      latencyMs: result.latencyMs,
      error: result.error
    });
    
    if (correct) {
      console.log(`  ✓ CORRECT (notify=${result.notify}, ${result.latencyMs}ms)`);
    } else {
      console.log(`  ✗ WRONG (notify=${result.notify}, expected=${email.shouldNotify})`);
    }
  }
  
  // ===== SUMMARY =====
  console.log('\n' + '='.repeat(70));
  console.log('EVALUATION SUMMARY');
  console.log('='.repeat(70));
  
  console.log(`\nParseltongue Tests: ${parseltonguePassCount}/8 passed`);
  if (parseltongueFailCount > 0) {
    console.log('  ⚠️  Security regression detected!');
  } else {
    console.log('  ✓ All injection attacks blocked');
  }
  
  const correctCount = userResults.filter(r => r.correct).length;
  const wrongCount = userResults.filter(r => !r.correct).length;
  
  // Calculate FP/FN based on results
  const newFP = userResults.filter(r => r.gotNotify === true && r.shouldNotify === false).length;
  const newFN = userResults.filter(r => r.gotNotify === false && r.shouldNotify === true).length;
  
  console.log(`\nUser Emails: ${correctCount}/${userResults.length} correct`);
  console.log(`  False Positives (FP): ${newFP}`);
  console.log(`  False Negatives (FN): ${newFN}`);
  console.log(`  Total Errors: ${wrongCount}`);
  
  if (wrongCount > 0) {
    console.log('\nErrors:');
    userResults.filter(r => !r.correct).forEach(r => {
      const errorType = r.gotNotify ? 'FP' : 'FN';
      console.log(`  [${errorType}] ${r.id}: got notify=${r.gotNotify}, expected=${r.shouldNotify}`);
    });
  }
  
  // Exit with error if there are failures
  const totalErrors = parseltongueFailCount + wrongCount;
  process.exit(totalErrors > 0 ? 1 : 0);
};

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

