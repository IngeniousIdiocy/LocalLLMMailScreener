import dotenv from 'dotenv';
dotenv.config();

import { google } from 'googleapis';

const requireEnv = (key) => {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env var ${key}`);
  }
  return val;
};

const createClient = () => {
  const clientId = requireEnv('GMAIL_CLIENT_ID');
  const clientSecret = requireEnv('GMAIL_CLIENT_SECRET');
  const refreshToken = requireEnv('GMAIL_REFRESH_TOKEN');
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oAuth2Client });
};

const lookbackMinutes = (() => {
  const arg = process.argv[2];
  const envVal = process.env.LOOKBACK_MINUTES;
  const raw = arg || envVal || '60';
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 60;
  return n;
})();

const gmail = createClient();

const oneOff = async () => {
  const now = Date.now();
  const afterSeconds = Math.floor((now - lookbackMinutes * 60 * 1000) / 1000);
  const query = `after:${afterSeconds}`;
  let total = 0;
  let pageToken;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'],
      maxResults: 500,
      q: query,
      pageToken
    });
    const batch = res.data.messages?.length || 0;
    total += batch;
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const perMinute = Math.round((total / lookbackMinutes) * 100) / 100;
  console.log(`Lookback window: ${lookbackMinutes} minutes`);
  console.log(`Gmail query: ${query}`);
  console.log(`Emails found: ${total}`);
  console.log(`Approx emails per minute: ${perMinute}`);
};

oneOff().catch((err) => {
  console.error('Failed to fetch email rate:', err.message);
  process.exit(1);
});
