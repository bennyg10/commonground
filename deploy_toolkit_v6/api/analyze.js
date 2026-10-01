// Common Ground — AI engine proxy (code checks, plan analysis, invoice reading).
// Signed-in users only, with a daily limit, so the public site can't spend the Anthropic key.
import { currentUser, rateLimited, trackUsage, storageReady } from './_lib.js';

export const config = { api: { bodyParser: { sizeLimit: '20mb' } } };
// One model for every tool; change it in Vercel with CG_AI_MODEL without touching code.
const MODEL = () => process.env.CG_AI_MODEL || 'claude-sonnet-5';
const DAILY_LIMIT = 40, ADMIN_DAILY_LIMIT = 300;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!storageReady()) return res.status(503).json({ error: { message: 'Storage not configured' } });

  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: { message: 'Sign in to use this tool.' } });
  if (await rateLimited(`cg:rl:ai:${u.identifier}:${new Date().toISOString().slice(0, 10)}`, u.admin ? ADMIN_DAILY_LIMIT : DAILY_LIMIT, 86400)) {
    return res.status(429).json({ error: { message: `Daily limit reached (${u.admin ? ADMIN_DAILY_LIMIT : DAILY_LIMIT} AI runs). It resets tomorrow.` } });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: { message: 'The AI engine key (ANTHROPIC_API_KEY) is not set in Vercel.' } });

  try {
    const { messages, max_tokens } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: { message: 'Nothing to analyze.' } });
    await trackUsage('ai');
    const response = await fetch(process.env.CG_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: Math.min(Number(max_tokens) || 4000, 8000),
        messages,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
