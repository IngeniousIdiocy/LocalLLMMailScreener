import { google } from 'googleapis';
import { simpleParser } from 'mailparser';
import { htmlToText } from 'html-to-text';

const decodeBase64Url = (input) => {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
};

const fallbackText = (parsed) => {
  if (parsed.text) return parsed.text;
  if (parsed.html) {
    return htmlToText(parsed.html, { wordwrap: 120, preserveNewlines: true });
  }
  return '';
};

export const createGmailClient = ({ clientId, clientSecret, refreshToken }) => {
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oAuth2Client });
};

export const listMessages = async (gmail, { maxResults, query }) => {
  const res = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    maxResults,
    q: query
  });
  return res.data.messages || [];
};

export const fetchRawMessage = async (gmail, id) => {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'raw'
  });
  return res.data;
};

export const parseRawEmail = async (rawData) => {
  const buffer = decodeBase64Url(rawData.raw || '');
  const parsed = await simpleParser(buffer);
  const attachments = (parsed.attachments || []).map((att) => ({
    filename: att.filename,
    contentType: att.contentType,
    size: att.size
  }));
  const bodyText = fallbackText(parsed);
  return {
    id: rawData.id,
    threadId: rawData.threadId,
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    cc: parsed.cc?.text || '',
    subject: parsed.subject || '',
    date: parsed.date ? parsed.date.toISOString() : '',
    body_text: bodyText,
    attachments
  };
};

export const gmailLinkFor = (message) => {
  if (!message) return '';
  const id = message.threadId || message.id;
  return `https://mail.google.com/mail/u/0/#inbox/${id}`;
};
