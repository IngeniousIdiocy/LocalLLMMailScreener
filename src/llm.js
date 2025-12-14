import axios from 'axios';

export const SYSTEM_PROMPT = `
You are a strict JSON generator for triaging emails. Output ONLY valid JSON with NO markdown, NO code fences, NO extra text.
Schema:
{
  "notify": true|false,
  "message_packet": {
    "title": "string <= 80 chars",
    "body": "string <= MAX_SMS_CHARS (aim under 600)",
    "urgency": "low"|"normal"|"high"
  },
  "confidence": 0..1,
  "reason": "short string"
}
If email needs my attention (action required, time-sensitive, direct question, security/finance/ops issues), notify=true; otherwise false. If notify=false, still provide a short title/body. Ensure JSON is valid and matches the schema exactly.`.trim();

const buildUserPrompt = (emailObj, maxSmsChars) => {
  const emailJson = JSON.stringify(emailObj, null, 2);
  return `Email to classify (raw JSON):
${emailJson}

MAX_SMS_CHARS value: ${maxSmsChars}
Return ONLY the JSON result following the schema.`;
};

export const callLLM = async ({
  llmBaseUrl,
  apiKey,
  model,
  temperature,
  maxOutputTokens,
  timeoutMs,
  emailObj,
  maxSmsChars
}) => {
  const url = `${llmBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(emailObj, maxSmsChars) }
  ];
  const payload = {
    model,
    temperature,
    max_tokens: maxOutputTokens,
    messages
  };
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const start = Date.now();
  const response = await axios.post(url, payload, {
    headers,
    timeout: timeoutMs
  });
  const latencyMs = Date.now() - start;
  const choice = response.data?.choices?.[0];
  if (!choice?.message?.content) {
    throw new Error('LLM response missing content');
  }
  const content = choice.message.content.trim();
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON from LLM: ${err.message}`);
  }

  const usage = response.data?.usage;
  const inputChars = JSON.stringify(payload)?.length || 0;
  const outputChars = content.length;
  const tokens = usage?.total_tokens
    ? usage.total_tokens
    : Math.ceil((inputChars + outputChars) / 4);

  return {
    content,
    parsed,
    tokens,
    latencyMs
  };
};

export const healthCheckLLM = async ({ llmBaseUrl, apiKey, timeoutMs }) => {
  const url = `${llmBaseUrl.replace(/\/+$/, '')}/v1/models`;
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const start = Date.now();
  try {
    await axios.get(url, { headers, timeout: timeoutMs });
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: 0, error: err.message };
  }
};
