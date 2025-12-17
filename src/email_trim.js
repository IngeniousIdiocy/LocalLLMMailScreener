import { extractUrls, analyzeSender } from './url_extract.js';

const DEFAULT_MAX_BODY_CHARS = parseInt(process.env.MAX_EMAIL_BODY_CHARS || '4000', 10);

const normalizeWhitespace = (text) => {
  if (!text) return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  const trimmedLines = normalized
    .split('\n')
    .map((line) => line.replace(/[ \f\v]+$/g, ''))
    .join('\n');
  return trimmedLines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const findFirstDelimiterIndex = (lines) => {
  const patterns = [
    { regex: /^On .+wrote:$/i, label: 'reply_header' },
    { regex: /^-----Original Message-----/i, label: 'original_message' },
    { regex: /^Begin forwarded message:?/i, label: 'forwarded_message' },
    { regex: /^From: .+Sent: .+To: .+Subject:/i, label: 'outlook_block' }
  ];

  let best = { index: -1, label: '' };
  patterns.forEach((p) => {
    const idx = lines.findIndex((line) => p.regex.test(line));
    if (idx >= 0 && (best.index === -1 || idx < best.index)) {
      best = { index: idx, label: p.label };
    }
  });

  // Detect quoted blocks starting with '>' after at least one non-quoted line
  const quoteIdx = lines.findIndex((line, idx) => line.trim().startsWith('>') && idx > 1);
  if (quoteIdx >= 0 && (best.index === -1 || quoteIdx < best.index)) {
    best = { index: quoteIdx, label: 'quoted_text' };
  }

  // Detect simple forwarded headers spread across multiple lines
  for (let i = 0; i < lines.length - 3; i += 1) {
    if (
      /^From:/i.test(lines[i]) &&
      /^Date:/i.test(lines[i + 1]) &&
      /^To:/i.test(lines[i + 2]) &&
      (best.index === -1 || i < best.index)
    ) {
      best = { index: i, label: 'forward_block' };
      break;
    }
  }

  return best.index >= 0 ? best : null;
};

const stripQuotedReplies = (text, removedSections) => {
  const lines = text.split('\n');
  const firstDelimiter = findFirstDelimiterIndex(lines);
  if (!firstDelimiter) return text;
  removedSections.push(firstDelimiter.label);
  return lines.slice(0, firstDelimiter.index).join('\n').trim();
};

const lastRegexIndex = (text, regex) => {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let match;
  let lastIndex = -1;
  while ((match = re.exec(text)) !== null) {
    lastIndex = match.index;
  }
  return lastIndex;
};

const stripFooters = (text, removedSections) => {
  const markers = [
    { regex: /(unsubscribe|manage (my )?preferences|manage subscription|update preferences)/i, label: 'unsubscribe_footer' },
    { regex: /(this email and any attachments|confidentiality notice|intended recipient|privileged and confidential)/i, label: 'confidentiality_footer' },
    { regex: /(view (this )?email in (your )?browser|view in browser)/i, label: 'view_in_browser_footer' }
  ];

  let trimmed = text;
  let applied = false;

  markers.forEach((marker) => {
    const idx = lastRegexIndex(trimmed, marker.regex);
    if (idx >= 0 && idx > trimmed.length * 0.35) {
      trimmed = trimmed.slice(0, idx).trim();
      removedSections.push(marker.label);
      applied = true;
    }
  });

  if (applied) {
    trimmed = trimmed.replace(/\n{3,}/g, '\n\n');
  }

  const trailingNoise = /(unsubscribe|manage (my )?preferences|manage subscription|update preferences|confidential|view (this )?email in (your )?browser)/i;
  const lines = trimmed.split('\n');
  while (lines.length && (lines[lines.length - 1].trim() === '' || trailingNoise.test(lines[lines.length - 1]))) {
    const popped = lines.pop();
    if (trailingNoise.test(popped)) {
      removedSections.push('footer_lines');
    }
  }
  let lastNoiseIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (trailingNoise.test(lines[i])) {
      lastNoiseIdx = i;
      break;
    }
  }
  if (lastNoiseIdx >= 0 && lastNoiseIdx >= Math.floor(lines.length * 0.4)) {
    lines.splice(lastNoiseIdx);
    removedSections.push('footer_lines');
  }
  trimmed = lines.join('\n').trim();

  return trimmed;
};

const enforceBodyCap = (body, maxChars, removedSections) => {
  if (body.length <= maxChars) return { body, excerpt: '', tail: '' };
  removedSections.push('length_cap');
  const marker = '\n[... trimmed ...]\n';
  const headLimit = Math.min(3000, Math.max(0, maxChars - marker.length - 500));
  const tailLimit = Math.min(500, Math.max(0, maxChars - marker.length - headLimit));
  const head = body.slice(0, headLimit);
  const tail = tailLimit > 0 ? body.slice(-tailLimit) : '';
  const capped = `${head}${marker}${tail}`.slice(0, maxChars);
  const excerpt = head.slice(0, 200);
  const tailExcerpt = tail ? tail.slice(-200) : '';
  return { body: capped, excerpt, tail: tailExcerpt };
};

export const trimEmailForLLM = (email, opts = {}) => {
  const maxBodyChars = parseInt(opts.maxBodyChars || DEFAULT_MAX_BODY_CHARS, 10);
  const removedSections = [];
  const originalBody = email.body_text || '';

  let body = normalizeWhitespace(originalBody);
  body = stripQuotedReplies(body, removedSections);
  body = stripFooters(body, removedSections);

  const capResult = enforceBodyCap(body, maxBodyChars, removedSections);
  const trimmedBody = capResult.body;

  const trimmedCharCount = trimmedBody.length;
  const stats = {
    original_char_count: originalBody.length,
    trimmed_char_count: trimmedCharCount,
    removed_sections: [...new Set(removedSections)],
    token_estimate: Math.ceil(Math.max(trimmedCharCount, 1) / 4)
  };

  const attachments = (email.attachments || []).map((att) => ({
    filename: att.filename,
    contentType: att.contentType,
    size: att.size
  }));

  const headers = {
    from: email.from || '',
    to: email.to || '',
    cc: email.cc || '',
    subject: email.subject || '',
    date: email.date || '',
    messageId: email.message_id || email.id || ''
  };

  // Extract and analyze URLs for phishing detection
  const urlAnalysis = extractUrls(originalBody);
  const senderAnalysis = analyzeSender(email.from);

  const trimmed = {
    ...email,
    headers,
    from: headers.from,
    to: headers.to,
    cc: headers.cc,
    subject: headers.subject,
    date: headers.date,
    body_text: trimmedBody,
    attachments,
    stats,
    url_analysis: urlAnalysis,
    sender_analysis: senderAnalysis
  };

  if (capResult.excerpt) trimmed.body_excerpt = capResult.excerpt;
  if (capResult.tail) trimmed.body_tail = capResult.tail;

  return trimmed;
};

export default trimEmailForLLM;
