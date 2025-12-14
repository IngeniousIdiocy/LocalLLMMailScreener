import twilio from 'twilio';

export const createTwilioClient = ({ accountSid, authToken }) => {
  if (!accountSid || !authToken) return null;
  return twilio(accountSid, authToken);
};

export const sendSms = async ({ client, to, from, body, dryRun }) => {
  if (dryRun) {
    return { sid: 'DRY_RUN', dryRun: true };
  }
  if (!client) {
    throw new Error('Twilio client not configured');
  }
  const res = await client.messages.create({ to, from, body });
  return { sid: res.sid, dryRun: false };
};

export const checkTwilioCredentials = async (client, accountSid) => {
  if (!client) return { ok: false, error: 'Missing Twilio credentials' };
  try {
    await client.api.accounts(accountSid).fetch();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};
