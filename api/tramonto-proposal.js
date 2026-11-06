// api/tramonto-proposal.js
// Serves the Tramonto landscape proposal one-pager and handles acceptance submissions.
// GET  /tramonto-proposal  → HTML page
// POST /tramonto-proposal  → record acceptance, email bmgordon10@gmail.com, return JSON
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendEmail, emailLayout, emailReady, clean } from './_lib.js';

function page() {
  return readFileSync(join(process.cwd(), 'api', '_pages', 'tramonto-proposal.html'), 'utf8');
}

const NOTIFY_EMAIL = 'commonground.helpme@gmail.com';
const PROJECT_NAME = 'Tramonto Landscape Proposal';

export default async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const html = page();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const name = clean(body?.name || '', 200);
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });

    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' });

    // Fire-and-forget email — log errors for debugging
    if (emailReady()) {
      sendEmail({
        to: NOTIFY_EMAIL,
        subject: `✅ Project Approved! — ${PROJECT_NAME}`,
        html: emailLayout(
          PROJECT_NAME,
          `<p style="margin:0 0 14px"><strong>${escHtml(name)}</strong> has accepted and signed the ${PROJECT_NAME}.</p>
           <p style="margin:0 0 14px;font-size:13px;color:#9BA5A3">Signed: ${escHtml(ts)} PT</p>`,
          null,
          `<p style="margin:0;font-size:12px">This notification was sent to ${NOTIFY_EMAIL} because you are the project owner.</p>`
        ),
        text: `${name} accepted the ${PROJECT_NAME}.\nSigned: ${ts} PT`,
      }).catch((err) => { console.error('[tramonto] email error:', err); });
    } else {
      console.error('[tramonto] emailReady() false — RESEND_API_KEY or CG_NOTIFY_FROM not set');
    }

    return res.status(200).json({ ok: true, name, ts });
  }

  res.setHeader('Allow', 'GET, HEAD, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
