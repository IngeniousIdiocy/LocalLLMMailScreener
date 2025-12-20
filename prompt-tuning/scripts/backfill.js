#!/usr/bin/env node
/**
 * Backfill Script
 * 
 * Fetches emails from recent_decisions in state.json and populates
 * the notified/ and notnotified/ folders with full email content.
 * 
 * Usage:
 *   node scripts/backfill.js              # Backfill all recent_decisions
 *   node scripts/backfill.js --limit=50   # Limit to 50 emails
 *   node scripts/backfill.js --dry-run    # Show what would be done
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const tuningRoot = path.resolve(__dirname, '..');

// Load parent project's .env for Gmail and LLM config
loadEnv({ path: path.join(projectRoot, '.env') });

// Import from parent project
import { createGmailClient, fetchRawMessage, parseRawEmail, gmailLinkFor } from '../../src/gmail.js';
import { trimEmailForLLM } from '../../src/email_trim.js';

const parseArgs = () => {
  const args = {
    limit: null,
    dryRun: false
  };
  
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--limit=')) {
      args.limit = parseInt(arg.slice(8), 10);
    }
  }
  
  return args;
};

const loadState = () => {
  const statePath = path.join(projectRoot, 'data', 'state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`State file not found: ${statePath}`);
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
};

// Extract message ID from gmail_link
const extractMessageId = (gmailLink) => {
  if (!gmailLink) return null;
  const match = gmailLink.match(/inbox\/([a-f0-9]+)$/i);
  return match ? match[1] : null;
};

const ensureDirs = () => {
  const notifiedDir = path.join(tuningRoot, 'notified');
  const notnotifiedDir = path.join(tuningRoot, 'notnotified');
  
  if (!fs.existsSync(notifiedDir)) {
    fs.mkdirSync(notifiedDir, { recursive: true });
  }
  if (!fs.existsSync(notnotifiedDir)) {
    fs.mkdirSync(notnotifiedDir, { recursive: true });
  }
  
  return { notifiedDir, notnotifiedDir };
};

const buildGmailClient = () => {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Gmail credentials in .env (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
  }
  
  return createGmailClient({ clientId, clientSecret, refreshToken });
};

const main = async () => {
  const args = parseArgs();
  
  console.log('='.repeat(70));
  console.log('BACKFILL: Fetching emails from Gmail');
  console.log('='.repeat(70));
  
  if (args.dryRun) {
    console.log('DRY-RUN MODE: No files will be written\n');
  }
  
  // Load state
  const state = loadState();
  let decisions = state.recent_decisions || [];
  const recentSends = state.recent_sends || [];
  
  console.log(`Found ${decisions.length} decisions in recent_decisions`);
  console.log(`Found ${recentSends.length} entries in recent_sends (notifications)`);
  
  // Build a set of all notified IDs from recent_sends (these are confirmed notifications)
  const notifiedIds = new Set();
  const notifiedMeta = new Map();
  
  for (const send of recentSends) {
    const messageId = extractMessageId(send.gmail_link);
    if (messageId) {
      notifiedIds.add(messageId);
      notifiedMeta.set(messageId, {
        from: send.from,
        subject: send.subject,
        urgency: send.urgency,
        reason: send.reason,
        sent_at: send.sent_at
      });
    }
  }
  
  console.log(`Extracted ${notifiedIds.size} unique notified message IDs`);
  
  // Build combined list: all decisions + any sends not in decisions
  const decisionIds = new Set(decisions.map(d => d.id));
  const combinedList = [...decisions];
  
  // Add notified emails from recent_sends that aren't already in decisions
  for (const messageId of notifiedIds) {
    if (!decisionIds.has(messageId)) {
      const meta = notifiedMeta.get(messageId);
      combinedList.push({
        id: messageId,
        notify: true,
        from: meta.from,
        subject: meta.subject,
        message_packet: { urgency: meta.urgency },
        reason: meta.reason,
        _source: 'recent_sends'
      });
    }
  }
  
  console.log(`Combined list: ${combinedList.length} emails to process`);
  
  // Apply limit if specified
  if (args.limit && args.limit < combinedList.length) {
    // Prioritize notified emails when limiting
    const notified = combinedList.filter(d => d.notify === true || notifiedIds.has(d.id));
    const notNotified = combinedList.filter(d => d.notify !== true && !notifiedIds.has(d.id));
    const limited = [...notified, ...notNotified.slice(0, Math.max(0, args.limit - notified.length))];
    combinedList.length = 0;
    combinedList.push(...limited.slice(0, args.limit));
    console.log(`Limited to ${args.limit} emails (prioritizing ${notified.length} notified)`);
  }
  
  let decisions_to_process = combinedList;
  
  const { notifiedDir, notnotifiedDir } = ensureDirs();
  
  // Build Gmail client
  let gmail;
  if (!args.dryRun) {
    console.log('\nConnecting to Gmail...');
    gmail = buildGmailClient();
  }
  
  const maxBodyChars = parseInt(process.env.MAX_EMAIL_BODY_CHARS || '4000', 10);
  
  let notifiedCount = 0;
  let notnotifiedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < decisions_to_process.length; i++) {
    const decision = decisions_to_process[i];
    const messageId = decision.id;
    // Check both the decision's notify flag AND if it's in the notifiedIds set
    const wasNotified = decision.notify === true || notifiedIds.has(messageId);
    const targetDir = wasNotified ? notifiedDir : notnotifiedDir;
    const targetFile = path.join(targetDir, `${messageId}.json`);
    
    // Skip if already exists
    if (fs.existsSync(targetFile)) {
      skippedCount++;
      continue;
    }
    
    console.log(`\n[${i + 1}/${decisions_to_process.length}] ${messageId} (notify=${wasNotified})`);
    console.log(`  Subject: ${decision.subject || '(unknown)'}`);
    
    if (args.dryRun) {
      console.log(`  Would write to: ${wasNotified ? 'notified' : 'notnotified'}/${messageId}.json`);
      if (wasNotified) notifiedCount++;
      else notnotifiedCount++;
      continue;
    }
    
    try {
      // The gmail_link uses threadId, but API needs messageId
      // For self-sent emails, these differ. Try message first, then thread lookup.
      let raw;
      try {
        raw = await fetchRawMessage(gmail, messageId);
      } catch (fetchErr) {
        if (fetchErr.message.includes('not found') || fetchErr.message.includes('404')) {
          // Might be a thread ID - look up messages in this thread
          console.log(`    Trying thread lookup for ${messageId}...`);
          const threadRes = await gmail.users.threads.get({
            userId: 'me',
            id: messageId,
            format: 'minimal'
          });
          const messages = threadRes.data.messages || [];
          if (messages.length > 0) {
            // Get the first message in the thread (or last for newest)
            const actualMessageId = messages[messages.length - 1].id;
            console.log(`    Found message ID: ${actualMessageId}`);
            raw = await fetchRawMessage(gmail, actualMessageId);
          } else {
            throw new Error('Thread found but no messages');
          }
        } else {
          throw fetchErr;
        }
      }
      const parsed = await parseRawEmail(raw);
      const gmailLink = gmailLinkFor(parsed);
      
      // Build email object like the app does
      const emailObj = {
        message_id: parsed.id,
        thread_id: parsed.threadId,
        gmail_link: gmailLink,
        date: parsed.date,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        body_text: parsed.body_text,
        attachments: parsed.attachments
      };
      
      // Trim email (same as production)
      const trimmedEmail = trimEmailForLLM(emailObj, { maxBodyChars });
      
      // Build output object
      const output = {
        id: messageId,
        gmail_link: gmailLink,
        from: parsed.from,
        subject: parsed.subject,
        date: parsed.date,
        trimmed_email: trimmedEmail,
        original_decision: {
          notify: decision.notify,
          confidence: decision.confidence,
          reason: decision.reason,
          message_packet: decision.message_packet
        },
        label: wasNotified ? 'TP' : 'TN'  // Assume correct initially
      };
      
      // Write to file
      fs.writeFileSync(targetFile, JSON.stringify(output, null, 2));
      
      if (wasNotified) notifiedCount++;
      else notnotifiedCount++;
      
      console.log(`  ✓ Saved to ${wasNotified ? 'notified' : 'notnotified'}/`);
      
    } catch (err) {
      errorCount++;
      console.log(`  ✗ Error: ${err.message}`);
      
      // If email not found (deleted), skip gracefully
      if (err.message.includes('404') || err.message.includes('Not Found')) {
        console.log(`    (Email may have been deleted from Gmail)`);
      }
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('\n' + '='.repeat(70));
  console.log('BACKFILL SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total processed:    ${decisions_to_process.length}`);
  console.log(`Notified (TP):      ${notifiedCount}`);
  console.log(`Not notified (TN):  ${notnotifiedCount}`);
  console.log(`Skipped (existing): ${skippedCount}`);
  console.log(`Errors:             ${errorCount}`);
  console.log('');
  
  if (!args.dryRun && (notifiedCount + notnotifiedCount) > 0) {
    console.log('Next steps:');
    console.log('1. Review emails in notified/ folder');
    console.log('   Change "label": "TP" to "label": "FP" for false positives');
    console.log('2. Review emails in notnotified/ folder');
    console.log('   Change "label": "TN" to "label": "FN" for false negatives');
    console.log('3. Run: node scripts/evaluate.js');
  }
};

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

