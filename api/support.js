// Common Ground — "Contact the platform" help form. Sends to the platform owner (CG_SUPPORT_EMAIL,
// default bmgordon10@gmail.com) and keeps a copy in the database so nothing is lost.
import fs from 'node:fs';
import path from 'node:path';
import { storageReady, redis, clean, rateLimited, ip, trackUsage, sendEmail, emailLayout, escHtml, emailReady, SUPPORT_EMAIL, normalizeIdentifier, canonicalRedirect } from './_lib.js';

const safeJSON = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

export default async function handler(req, res) {
  if (req.method === 'GET') {
    { const qs = new URLSearchParams(); ['from', 'project'].forEach((k) => { if (req.query[k]) qs.set(k, clean(req.query[k], 120)); });
      if (canonicalRedirect(req, res, '/help' + (qs.toString() ? '?' + qs : ''))) return; }
    const html = fs.readFileSync(path.join(process.cwd(), 'api', '_pages', 'help.html'), 'utf8');
    const ctx = { from: clean(req.query.from, 120), project: clean(req.query.project, 40) };
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html.replace('</head>', `<script>window.CG_HELP=${safeJSON(ctx)};</script>\n</head>`));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!storageReady()) return res.status(503).json({ error: 'storage_not_configured' });
  await trackUsage();
  if (await rateLimited(`cg:rl:support:${ip(req)}`, 8, 3600)) return res.status(429).json({ error: 'too_many_attempts' });
  const b = req.body || {};
  const name = clean(b.name, 80), email = normalizeIdentifier(b.email), phone = clean(b.phone, 30);
  const topic = clean(b.topic, 60) || 'General question', message = clean(b.message, 3000), project = clean(b.project, 40);
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad_email' });
  if (message.length < 5) return res.status(400).json({ error: 'message_required' });
  const item = { name, email, phone, topic, message, project, at: new Date().toISOString(), ip: ip(req) };
  await redis(['LPUSH', 'cg:support', JSON.stringify(item)]);
  await redis(['LTRIM', 'cg:support', '0', '499']);
  const sent = await sendEmail({
    to: SUPPORT_EMAIL(), replyTo: email,
    subject: `Help request: ${topic} — ${name}`,
    html: emailLayout('Help request', `<p style="margin:0 0 10px"><b>${escHtml(name)}</b> · ${escHtml(email)}${phone ? ' · ' + escHtml(phone) : ''}${project ? ' · project: ' + escHtml(project) : ''}</p>
      <p style="margin:0 0 6px;color:#D5DC99"><b>${escHtml(topic)}</b></p><p style="margin:0;white-space:pre-wrap">${escHtml(message)}</p>
      <p style="margin:14px 0 0;color:#8a8d88;font-size:12px">Reply to this email to answer them directly.</p>`),
    text: `${name} <${email}> ${phone}\nProject: ${project}\nTopic: ${topic}\n\n${message}`,
  });
  return res.status(200).json({ ok: true, emailed: !!sent.ok, emailConfigured: emailReady() });
}
