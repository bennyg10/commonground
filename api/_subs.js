// Common Ground — sub recommendations.
// A homeowner (or GC) asks the platform for a few well-rated trades near the job. The request
// lands in the platform inbox and the console queue with a 12-hour promise; the platform team
// researches (optionally with an AI web-search draft they review), then sends the options back.
import { redis, getJSON, setJSON, clean, token, rateLimited, sendEmail, emailLayout, escHtml, SUPPORT_EMAIL,
  siteOrigin, projectPath, roleSlug, projectTitle, notify, getProjectMeta } from './_lib.js';

export const SUB_SLA_HOURS = 12;
const MAX_PER_PROJECT = 60, MAX_OPTIONS = 6;
const listKey = (p) => `cg:subreqs:${p}`;
const now = () => new Date().toISOString();

export const zipFrom = (s) => ((String(s || '').match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '');
export const laTime = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' PT';

export async function listSubRequests(project) { return (await getJSON(listKey(project))) || []; }
async function saveList(project, list) { await setJSON(listKey(project), list.slice(-MAX_PER_PROJECT)); }

// what members of the project see (no platform-only notes)
export const publicSubRequest = (r) => { const o = Object.assign({}, r); delete o.adminNote; delete o.draft; return o; };

export async function createSubRequest(req, project, u, role, b) {
  if (role === 'trade') return { status: 403, body: { error: 'forbidden' } };
  if (await rateLimited(`cg:rl:subreq:${u.identifier}:${new Date().toISOString().slice(0, 10)}`, u.admin ? 100 : 8, 86400)) return { status: 429, body: { error: 'too_many' } };
  const trade = clean(b.trade, 60), scope = clean(b.scope, 1200), zip = zipFrom(b.zip);
  if (!trade) return { status: 400, body: { error: 'trade_required' } };
  if (scope.length < 5) return { status: 400, body: { error: 'scope_required' } };
  if (!zip) return { status: 400, body: { error: 'zip_required' } };
  const at = now();
  const r = {
    id: token(6), project, trade, scope, zip, timing: clean(b.timing, 40), budget: clean(b.budget, 60),
    phone: clean(b.phone, 30), contactEmail: clean(b.email, 120) || (u.identifier.includes('@') ? u.identifier : ''),
    by: u.identifier, byName: u.name, byRole: u.admin && role === 'gc' ? 'gc' : role, at,
    dueAt: new Date(Date.now() + SUB_SLA_HOURS * 3600e3).toISOString(), status: 'searching', options: [],
  };
  const list = await listSubRequests(project); list.push(r); await saveList(project, list);
  await redis(['SADD', 'cg:subq', project]);

  const meta = (await getProjectMeta(project)) || {};
  const rows = [['Trade', trade], ['Job', scope], ['Zip', zip], ['When', r.timing || '—'], ['Budget', r.budget || '—'],
    ['Requested by', `${u.name} (${role === 'client' ? 'homeowner' : role === 'gc' ? 'GC' : role})`], ['Reach them', [r.contactEmail, r.phone].filter(Boolean).join(' · ') || u.identifier],
    ['Project', `${projectTitle(project)}${meta.address ? ' — ' + meta.address : ''}`], ['Promised by', laTime(r.dueAt)]];
  const table = `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;font-size:13px">${rows.map(([k, v]) =>
    `<tr><td style="padding:5px 12px 5px 0;color:#8a8d88;vertical-align:top;white-space:nowrap">${escHtml(k)}</td><td style="padding:5px 0;color:#E8EAE6">${escHtml(v)}</td></tr>`).join('')}</table>`;
  await sendEmail({
    to: SUPPORT_EMAIL(),
    subject: `[Sub request] ${trade} · ${zip} · due ${laTime(r.dueAt)}`,
    html: emailLayout('New sub recommendation request', `<p style="margin:0 0 12px">Send 3–5 well-rated options within ${SUB_SLA_HOURS} hours.</p>${table}`,
      { label: 'Open the request queue', url: `${siteOrigin(req)}/admin#subs` }),
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nQueue: ${siteOrigin(req)}/admin#subs`,
    replyTo: r.contactEmail || undefined,
  }).catch(() => {});
  if (r.contactEmail) {
    await sendEmail({
      to: r.contactEmail,
      subject: `We're finding ${trade.toLowerCase()} options for ${projectTitle(project)}`,
      html: emailLayout(projectTitle(project), `<p style="margin:0 0 12px">Thanks, ${escHtml(String(u.name).split(' ')[0])}. We're looking for the best-rated ${escHtml(trade.toLowerCase())} options near ${escHtml(zip)}.</p><p style="margin:0">You'll have a short list on your project page by <b>${escHtml(laTime(r.dueAt))}</b>, and we'll email you when it's ready.</p>`,
        { label: 'Open your project', url: `${siteOrigin(req)}/${projectPath(project)}/${roleSlug(role)}` }),
      text: `We're looking for the best-rated ${trade.toLowerCase()} options near ${zip}. You'll have a short list by ${laTime(r.dueAt)}.`,
    }).catch(() => {});
  }
  return { status: 200, body: { ok: true, request: publicSubRequest(r) } };
}

export async function cancelSubRequest(project, u, role, id) {
  const list = await listSubRequests(project);
  const r = list.find((x) => x.id === id);
  if (!r) return { status: 404, body: { error: 'not_found' } };
  if (!(u.admin || r.by === u.identifier || role === 'client')) return { status: 403, body: { error: 'forbidden' } };
  if (r.status === 'searching') r.status = 'cancelled'; else r.status = 'closed';
  r.closedAt = now(); await saveList(project, list);
  return { status: 200, body: { ok: true, request: publicSubRequest(r) } };
}

// record which option the owner invited (so the console can see what worked)
export async function markSubInvited(project, id, optId, identifier) {
  const list = await listSubRequests(project);
  const r = list.find((x) => x.id === id); if (!r) return;
  const o = (r.options || []).find((x) => x.id === optId); if (!o) return;
  o.invited = now(); o.invitedAs = identifier; await saveList(project, list);
}

// ── platform console ──
export async function subQueue() {
  const projects = (await redis(['SMEMBERS', 'cg:subq'])) || [];
  const out = [];
  for (const p of projects) {
    const meta = (await getProjectMeta(p)) || {};
    (await listSubRequests(p)).forEach((r) => out.push(Object.assign({}, r, { projectName: meta.name || p, projectPath: projectPath(p), address: meta.address || '' })));
  }
  const open = (r) => r.status === 'searching';
  out.sort((a, b) => (open(b) - open(a)) || (open(a) ? a.dueAt.localeCompare(b.dueAt) : b.at.localeCompare(a.at)));
  return out;
}

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const url = (v) => { const s = clean(v, 300); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ''; };
export function cleanOptions(opts) {
  return (Array.isArray(opts) ? opts : []).slice(0, MAX_OPTIONS).map((o) => ({
    id: clean(o.id, 20) || token(4), name: clean(o.name, 80), company: clean(o.company, 80),
    rating: num(o.rating, 0, 5), reviews: o.reviews === '' || o.reviews == null ? null : Math.round(num(o.reviews, 0, 100000) || 0),
    reviewSource: clean(o.reviewSource, 40), phone: clean(o.phone, 30), email: clean(o.email, 120), website: url(o.website),
    license: clean(o.license, 60), why: clean(o.why, 400), source: url(o.source), invited: clean(o.invited, 40) || undefined,
  })).filter((o) => o.name || o.company);
}

export async function saveSubOptions(req, me, project, id, b) {
  const list = await listSubRequests(project);
  const r = list.find((x) => x.id === id);
  if (!r) return { status: 404, body: { error: 'not_found' } };
  r.options = cleanOptions(b.options);
  r.adminNote = clean(b.adminNote, 600);
  r.message = clean(b.message, 600);
  if (b.send) {
    if (!r.options.length) return { status: 400, body: { error: 'no_options' } };
    const first = !r.sentAt;
    r.status = 'ready'; r.sentAt = now(); r.sentBy = me.name;
    await notify(req, project, { text: `${first ? 'Your' : 'Updated'} ${r.trade.toLowerCase()} recommendations are ready — ${r.options.length} option${r.options.length === 1 ? '' : 's'} near ${r.zip}`,
      targets: [r.byRole === 'gc' ? 'gc' : 'client'], by: 'Common Ground', byAccount: me.identifier });
  }
  r.updatedAt = now();
  await saveList(project, list);
  return { status: 200, body: { ok: true, request: r } };
}

// AI research draft: web search for top-rated trades near the zip. Always reviewed by a person before it is sent.
export async function draftSubOptions(r, address) {
  if (!process.env.ANTHROPIC_API_KEY) return { status: 503, body: { error: 'ai_not_configured' } };
  const prompt = `You help a construction platform recommend subcontractors to a homeowner.
Find the ${Math.min(MAX_OPTIONS, 5)} best-rated ${r.trade} businesses that serve zip code ${r.zip}${address ? ` (job site: ${address})` : ''}.
Job: ${r.scope}${r.timing ? `\nTiming: ${r.timing}` : ''}${r.budget ? `\nBudget: ${r.budget}` : ''}
Search the web (Google/Yelp/Angi/BBB reviews, state contractor license lookups). Prefer licensed, insured businesses with many recent reviews and a rating of 4.5 or higher, based close to the zip code.
Only include businesses you actually found in search results; never invent names, phone numbers, ratings or license numbers. Leave a field empty if you did not find it.
Reply with ONLY a JSON array, no prose, where each item is:
{"name":"contact or business name","company":"business name","rating":4.8,"reviews":120,"reviewSource":"Yelp","phone":"","email":"","website":"https://...","license":"CSLB #...","why":"one sentence on why they fit this job","source":"https://page-where-you-found-the-rating"}`;
  const model = process.env.CG_AI_MODEL || 'claude-sonnet-5';
  try {
    const resp = await fetch(process.env.CG_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 4000,
        tools: [{ type: process.env.CG_WEB_SEARCH_TOOL || 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { status: 502, body: { error: 'ai_failed', message: String((data.error && data.error.message) || resp.status).slice(0, 300) } };
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const m = text.match(/\[[\s\S]*\]/);
    let opts = [];
    try { opts = m ? JSON.parse(m[0]) : []; } catch (e) { opts = []; }
    const cleaned = cleanOptions(opts);
    if (!cleaned.length) return { status: 502, body: { error: 'ai_no_results', message: text.slice(0, 300) } };
    return { status: 200, body: { ok: true, options: cleaned } };
  } catch (e) {
    return { status: 502, body: { error: 'ai_failed', message: String(e.message || e).slice(0, 200) } };
  }
}
