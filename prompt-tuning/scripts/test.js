#!/usr/bin/env node
/**
 * Quick tests for prompt-tuning logic
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const tuningRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || 'Assertion failed');
};

const assertEqual = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
};

// ===== LABEL LOGIC TESTS =====
console.log('\n📋 Label Logic Tests');
console.log('-'.repeat(50));

// Simulate the label logic from evaluate.js / tune.js
const computeShouldNotify = (folder, label) => {
  if (folder === 'notified') {
    // In notified/ folder: FP means should NOT have notified
    return label !== 'FP';
  } else {
    // In notnotified/ folder: FN means SHOULD have notified
    return label === 'FN';
  }
};

test('notified + TP → shouldNotify = true', () => {
  assertEqual(computeShouldNotify('notified', 'TP'), true);
});

test('notified + FP → shouldNotify = false', () => {
  assertEqual(computeShouldNotify('notified', 'FP'), false);
});

test('notnotified + TN → shouldNotify = false', () => {
  assertEqual(computeShouldNotify('notnotified', 'TN'), false);
});

test('notnotified + FN → shouldNotify = true', () => {
  assertEqual(computeShouldNotify('notnotified', 'FN'), true);
});

// Edge case: default labels
test('notified + undefined → shouldNotify = true (default TP)', () => {
  assertEqual(computeShouldNotify('notified', undefined), true);
});

test('notnotified + undefined → shouldNotify = false (default TN)', () => {
  assertEqual(computeShouldNotify('notnotified', undefined), false);
});


// ===== PARSELTONGUE FILTER TESTS =====
console.log('\n🐍 Parseltongue Filter Tests');
console.log('-'.repeat(50));

test('loads only parseltongue category (8 tests)', () => {
  const casesPath = path.join(projectRoot, 'test', 'fixtures', 'prompt_injection_cases.json');
  const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const parseltongue = allCases.filter(c => c.category === 'parseltongue');
  
  assertEqual(parseltongue.length, 8, `Expected 8 parseltongue tests, got ${parseltongue.length}`);
});

test('all parseltongue tests expect notify=false', () => {
  const casesPath = path.join(projectRoot, 'test', 'fixtures', 'prompt_injection_cases.json');
  const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const parseltongue = allCases.filter(c => c.category === 'parseltongue');
  
  const allExpectFalse = parseltongue.every(c => c.expect_notify === false);
  assert(allExpectFalse, 'Some parseltongue tests expect notify=true');
});

test('parseltongue test IDs are correct', () => {
  const casesPath = path.join(projectRoot, 'test', 'fixtures', 'prompt_injection_cases.json');
  const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const parseltongue = allCases.filter(c => c.category === 'parseltongue');
  
  const expectedIds = [
    'injection_leetspeak',
    'injection_base64',
    'injection_rot13',
    'injection_polyglot',
    'injection_unicode_homoglyph',
    'injection_token_boundary',
    'injection_language_mix',
    'injection_kitchen_sink'
  ];
  
  const actualIds = parseltongue.map(c => c.id).sort();
  const expectedSorted = expectedIds.sort();
  
  assertEqual(
    JSON.stringify(actualIds), 
    JSON.stringify(expectedSorted),
    `IDs don't match: ${actualIds.join(', ')}`
  );
});

test('basic category is excluded (5 tests)', () => {
  const casesPath = path.join(projectRoot, 'test', 'fixtures', 'prompt_injection_cases.json');
  const allCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const basic = allCases.filter(c => c.category === 'basic');
  
  assertEqual(basic.length, 5, `Expected 5 basic tests, got ${basic.length}`);
});


// ===== CONFIG TESTS =====
console.log('\n⚙️  Config Tests');
console.log('-'.repeat(50));

test('config.json is valid JSON', () => {
  const configPath = path.join(tuningRoot, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert(config.max_attempts > 0, 'max_attempts should be > 0');
});

test('config has evaluation settings', () => {
  const configPath = path.join(tuningRoot, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert('evaluation' in config, 'config should have evaluation key');
  assert('errors_only' in config.evaluation, 'evaluation should have errors_only');
});

test('current_prompt.txt exists and is non-empty', () => {
  const promptPath = path.join(tuningRoot, 'current_prompt.txt');
  const content = fs.readFileSync(promptPath, 'utf8');
  assert(content.length > 100, 'Prompt should be substantial');
});


// ===== ATTEMPTS LOG TESTS =====
console.log('\n📝 Attempts Log Tests');
console.log('-'.repeat(50));

test('attempts_log.md exists', () => {
  const logPath = path.join(tuningRoot, 'attempts_log.md');
  assert(fs.existsSync(logPath), 'attempts_log.md should exist');
});

test('attempts_log.md has summary table header', () => {
  const logPath = path.join(tuningRoot, 'attempts_log.md');
  const content = fs.readFileSync(logPath, 'utf8');
  assert(content.includes('| Attempt |'), 'Should have summary table');
});

test('attempt counting works on empty log', () => {
  const content = `# Prompt Tuning Attempts Log

## Summary

| Attempt | Date | ... |
|---------|------|-----|

---
`;
  const attemptMatches = content.match(/## Attempt \d+/g) || [];
  assertEqual(attemptMatches.length, 0, 'Empty log should have 0 attempts');
});

test('attempt counting works with attempts', () => {
  const content = `# Prompt Tuning Attempts Log

## Summary
...

## Attempt 1
...

## Attempt 2
...
`;
  const attemptMatches = content.match(/## Attempt \d+/g) || [];
  assertEqual(attemptMatches.length, 2, 'Should count 2 attempts');
});


// ===== SUMMARY =====
console.log('\n' + '='.repeat(50));
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);

