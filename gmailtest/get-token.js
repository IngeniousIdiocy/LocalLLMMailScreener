require('dotenv').config();
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing env vars: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in gmailtest/.env');
  process.exit(1);
}

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const redirectUri = GOOGLE_REDIRECT_URI || 'http://localhost';

const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  redirectUri
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPES
});

console.log('1) Open this URL in your browser to authorize access to Gmail:\n');
console.log(authUrl);
console.log(
  '\n2) After approving, you will be redirected to localhost (it may show a connection error). Copy the full URL (it includes "?code=...").'
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('\n3) Paste the code or full redirected URL here: ', async input => {
  rl.close();

  const codeMatch = input.trim().match(/[?&]code=([^&]+)/);
  const code = codeMatch ? decodeURIComponent(codeMatch[1]) : input.trim();

  if (!code) {
    console.error('No code found. Please rerun and paste the "code" from the redirect URL.');
    process.exit(1);
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    if (!tokens.refresh_token) {
      console.error('No refresh token returned. Add prompt=consent and rerun, or revoke prior consent and try again.');
      process.exit(1);
    }

    const refreshToken = tokens.refresh_token;

    // Validate token by making a test Gmail API call
    console.log('\nValidating token with Gmail API...');
    oAuth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    try {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      console.log(`Token verified! Connected to: ${profile.data.emailAddress}`);
    } catch (validateErr) {
      console.error('Token validation failed - Gmail API rejected the token:', validateErr.message);
      console.error('Token was NOT saved. Please try again.');
      process.exit(1);
    }

    // Update main project .env
    const mainEnvPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(mainEnvPath)) {
      let envContent = fs.readFileSync(mainEnvPath, 'utf8');
      if (envContent.match(/^GMAIL_REFRESH_TOKEN=.*/m)) {
        envContent = envContent.replace(/^GMAIL_REFRESH_TOKEN=.*/m, `GMAIL_REFRESH_TOKEN=${refreshToken}`);
      } else {
        envContent += `\nGMAIL_REFRESH_TOKEN=${refreshToken}\n`;
      }
      fs.writeFileSync(mainEnvPath, envContent);
      console.log('\nSuccess! Updated GMAIL_REFRESH_TOKEN in main project .env');
    } else {
      console.log('\nSuccess! Main .env not found. Add this to your .env as GMAIL_REFRESH_TOKEN:');
      console.log(refreshToken);
    }
  } catch (err) {
    console.error('Failed to exchange code for tokens:', err.message);
    if (err.response?.data) {
      console.error(err.response.data);
    }
    process.exit(1);
  }
});
