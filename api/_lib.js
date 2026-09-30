// Common Ground — shared server helpers (storage, passwords, sessions).
// Files starting with "_" inside /api are not deployed as endpoints.
import crypto from 'node:crypto';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const storageReady = () => !!(REDIS_URL && REDIS_TOKEN);

export async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `Redis error ${r.status}`);
  return data.result;
}
export async function getJSON(key) {
  const v = await redis(['GET', key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
export async function setJSON(key, obj, ttlSeconds) {
  const cmd = ['SET', key, JSON.stringify(obj)];
  if (ttlSeconds) cmd.push('EX', String(ttlSeconds));
  return redis(cmd);
}

export const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const ROLES = ['client', 'gc', 'trade'];
// URL name for each role: the homeowner's address says /homeowner (the role is stored as 'client')
export const roleSlug = (r) => (r === 'client' ? 'homeowner' : r);

// ── projects ──
// Built-in projects have hand-built pages; everything else is created from the dashboard and
// stored in Redis (cg:proj:<id>, id == its URL path). The internal id never changes, so live data
// stays put when a project gets a new address (anita → /141nanita).
export const BUILTIN = {
  anita: { id: 'anita', path: '141nanita', name: '141 N Anita Ave', title: '141 N Anita', address: '141 N Anita Ave, Los Angeles, CA 90049',
           classification: 'residential', scope: 'demolition', page: 'anita.html', builtin: true },
  coolidge: { id: 'coolidge', path: '2560coolidge', name: '2560 Coolidge Ave', title: '2560 Coolidge', address: '2560 Coolidge Ave, Santa Monica, CA',
              classification: 'residential', scope: 'remodel', page: 'coolidge.html', builtin: true },
};
export const PROJECTS = Object.keys(BUILTIN);        // built-ins only; use listProjects() for everything
export const PROJECT_NAMES = Object.fromEntries(Object.values(BUILTIN).map((p) => [p.id, p.name]));
export const RESERVED_PATHS = ['admin', 'help', 'dashboard', 'api', 'assets', 'index', 'login', 'signup', 'bid', 'anita', 'www', 'app', 'static', 'public', 'favicon'];
const META_CACHE = {};
const byPath = Object.fromEntries(Object.values(BUILTIN).map((p) => [p.path, p.id]));
export async function getProjectMeta(id) {
  if (!id) return null;
  if (BUILTIN[id]) return BUILTIN[id];
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !storageReady()) return null;
  const m = await getJSON(`cg:proj:${id}`);
  if (m) META_CACHE[id] = m;
  return m;
}
export async function validProject(id) { return !!(await getProjectMeta(id)); }
export async function projectIdFromPath(path) {
  path = String(path || '').toLowerCase();
  if (byPath[path]) return byPath[path];
  if (BUILTIN[path]) return path;                                    // old /anita links
  return (await getProjectMeta(path)) ? path : null;
}
export const projectPath = (id) => (BUILTIN[id] ? BUILTIN[id].path : id);
export async function listProjects() {
  const ids = storageReady() ? ((await redis(['SMEMBERS', 'cg:projects'])) || []) : [];
  const out = Object.values(BUILTIN).slice();
  for (const id of ids.sort()) { const m = await getProjectMeta(id); if (m) out.push(m); }
  return out;
}

// email → lowercase; phone → +1XXXXXXXXXX (10 digits assumed US)
export function normalizeIdentifier(raw) {
  const s = clean(raw, 120);
  if (!s) return '';
  if (s.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : '';
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length >= 8 && digits.length <= 15 && s.trim().startsWith('+')) return '+' + digits;
  return '';
}

// scrypt password hashing
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}
export const passwordProblem = (p) =>
  typeof p !== 'string' || p.length < 8 ? 'Use at least 8 characters.' : p.length > 200 ? 'That password is too long.' : '';

export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// sessions (HttpOnly cookie → Redis)
const SESSION_DAYS = 30;
const COOKIE = 'cg_session';
export function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function cookieFlags(req) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
export async function createSession(req, res, userKey) {
  const t = token();
  await setJSON(`cg:session:${t}`, { user: userKey, at: new Date().toISOString() }, SESSION_DAYS * 86400);
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Max-Age=${SESSION_DAYS * 86400}${cookieFlags(req)}`);
}
export async function destroySession(req, res) {
  const t = parseCookies(req)[COOKIE];
  if (t) await redis(['DEL', `cg:session:${t}`]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0${cookieFlags(req)}`);
}
export async function currentUser(req) {
  if (!storageReady()) return null;
  const t = parseCookies(req)[COOKIE];
  if (!t || t.length > 100) return null;
  const s = await getJSON(`cg:session:${t}`);
  if (!s) return null;
  const u = await getJSON(`cg:user:${s.user}`);
  if (!u || u.disabled) return null;
  // "sign out everywhere" (admin console) invalidates every session issued before the cutoff
  if (u.sessionsValidAfter && (!s.at || s.at < u.sessionsValidAfter)) return null;
  return u;
}
// every account id, for the admin console (SADD wherever an account is created)
export const indexUser = (identifier) => redis(['SADD', 'cg:users', identifier]).catch(() => {});
// public shape sent to the browser (never the hash)
export const publicUser = (u) => u && ({ name: u.name, identifier: u.identifier, admin: !!u.admin, projects: u.projects || {}, accountType: u.accountType || '', company: u.company || '' });

// role on a project: admin can act as any role; others get what they were invited as
export function roleFor(u, project) {
  if (!u) return null;
  return (u.projects || {})[project] || (u.admin ? 'gc' : null);
}
export const canView = (u, project, role) => !!u && (u.admin || (u.projects || {})[project] === role);

// simple fixed-window rate limit
export async function rateLimited(key, max, windowSeconds) {
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, String(windowSeconds)]);
  return n > max;
}
export const ip = (req) => clean(String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || '', 60);

// ── usage tracking (feeds the admin "when to upgrade" panel) ──
export const monthKey = () => new Date().toISOString().slice(0, 7);
export async function trackUsage(field = 'requests', by = 1) {
  try { await redis(['HINCRBY', `cg:usage:${monthKey()}`, field, String(by)]); } catch (e) { /* never block a request on stats */ }
}

// ── notifications: in-app feed + optional email (Resend) ──
// Env (optional): RESEND_API_KEY, CG_NOTIFY_FROM (e.g. "Common Ground <updates@yourdomain.com>")
export async function notify(req, project, n) {
  const item = { id: token(8), at: new Date().toISOString(), text: clean(n.text, 300), targets: n.targets || ['gc'],
                 decision: n.decision || '', by: n.by || '', byAccount: n.byAccount || '' };
  await redis(['LPUSH', `cg:notify:${project}`, JSON.stringify(item)]);
  await redis(['LTRIM', `cg:notify:${project}`, '0', '199']);
  let emailed = [];
  if (!n.noEmail) emailed = (await sendEmails(req, project, item).catch(() => [])) || [];
  await platformCopy(req, project, item, emailed).catch(() => {});
  return item;
}
// Every notification on every project is also copied to the platform inbox (CG_SUPPORT_EMAIL).
// Turn off with CG_PLATFORM_COPY=off.
async function platformCopy(req, project, item, alreadyEmailed) {
  if (!emailReady() || (process.env.CG_PLATFORM_COPY || '').toLowerCase() === 'off') return;
  const inbox = SUPPORT_EMAIL().toLowerCase();
  if (!inbox || alreadyEmailed.includes(inbox) || item.byAccount === inbox) return;
  const who = item.by ? ` · by ${item.by}` : '';
  await sendEmail({
    to: inbox,
    subject: `[Platform] ${projectTitle(project)}: ${item.text}`.slice(0, 150),
    html: emailLayout(`Platform copy · ${projectTitle(project)}`,
      `<p style="margin:0 0 10px">${escHtml(item.text)}</p><p style="margin:0;color:#8a8d88;font-size:12px">Sent to: ${escHtml(item.targets.map((r) => ({ client: 'Owner', gc: 'GC', trade: 'Trade' }[r] || r)).join(', '))}${escHtml(who)}</p>`,
      { label: 'Open the platform console', url: `${siteOrigin(req)}/admin` }),
    text: `${item.text}${who}\n\nPlatform console: ${siteOrigin(req)}/admin`,
  });
}
async function sendEmails(req, project, item) {
  if (!emailReady()) return [];
  const sent = [];
  const flat = (await redis(['HGETALL', `cg:members:${project}`])) || [];
  const byRole = {};
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const m = JSON.parse(flat[i + 1]);
      if (m.status !== 'active' || !m.identifier.includes('@') || m.identifier === item.byAccount) continue;
      if (!item.targets.includes(m.role)) continue;
      (byRole[m.role] = byRole[m.role] || []).push(m.identifier); sent.push(m.identifier.toLowerCase());
    } catch (e) {}
  }
  for (const role of Object.keys(byRole)) {
    await sendEmail({
      to: byRole[role],
      subject: `${projectTitle(project)}: ${item.text}`.slice(0, 150),
      html: emailLayout(projectTitle(project), `<p style="margin:0 0 14px">${escHtml(item.text)}</p>`, { label: 'Open the project', url: `${siteOrigin(req)}/${projectPath(project)}/${roleSlug(role)}` }),
      text: `${item.text}\n\nOpen the project: ${siteOrigin(req)}/${projectPath(project)}/${roleSlug(role)}\n\n— Common Ground`,
    });
  }
  return sent;
}

// ── email (Resend) ──
export const emailReady = () => !!(process.env.RESEND_API_KEY && process.env.CG_NOTIFY_FROM);
export const SUPPORT_EMAIL = () => (process.env.CG_SUPPORT_EMAIL || 'commonground.helpme@gmail.com').trim();
export const projectTitle = (p) => (BUILTIN[p] ? BUILTIN[p].title : (META_CACHE[p] && META_CACHE[p].name) || p);
// CG_SITE_URL (e.g. https://buildcommonground.io) makes every emailed/copied link use your own domain
const SITE_URL = () => (process.env.CG_SITE_URL || '').trim().replace(/\/+$/, '');
export const siteOrigin = (req) => SITE_URL() || `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
// Pages opened on the old *.vercel.app address jump to your domain (production only; previews and APIs untouched)
export function canonicalRedirect(req, res, pathAndQuery) {
  const site = SITE_URL();
  if (!site || req.method !== 'GET' || process.env.VERCEL_ENV !== 'production') return false;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  let siteHost = ''; try { siteHost = new URL(site).host.toLowerCase(); } catch (e) { return false; }
  if (!host || host === siteHost || !host.endsWith('.vercel.app')) return false;
  res.setHeader('Location', site + (pathAndQuery || '/'));
  res.status(307).end();
  return true;
}
export const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!emailReady()) return { skipped: true };
  const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return { skipped: true };
  try {
    const r = await fetch(process.env.CG_RESEND_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      // replies to any platform email land in the platform inbox unless a sender is given (help form → the user)
      body: JSON.stringify({ from: process.env.CG_NOTIFY_FROM, to: list, subject, html, text, reply_to: replyTo || SUPPORT_EMAIL() }),
    });
    if (r.ok) await trackUsage('emails', list.length);
    return { ok: r.ok };
  } catch (e) { return { ok: false }; }
}
// Branded HTML email: dark card, lime button, table layout for mail clients
export function emailLayout(eyebrow, bodyHtml, button, footerHtml) {
  const btn = button ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:18px 0 6px"><tr><td style="background:#D5DC99;border-radius:9px"><a href="${escHtml(button.url)}" style="display:inline-block;padding:13px 22px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#0B0B0E;text-decoration:none">${escHtml(button.label)}</a></td></tr></table>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0B0B0E">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B0B0E;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#17161C;border:1px solid #2a2930;border-radius:14px">
<tr><td style="padding:22px 24px 0;font-family:Arial,sans-serif">
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="width:28px;height:28px;background:#D5DC99;border-radius:7px;text-align:center;font-size:11px;font-weight:800;color:#0B0B0E">CG</td><td style="padding-left:8px;font-size:13px;font-weight:700;color:#D5DC99">Common Ground</td></tr></table>
<div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#737F73;margin:18px 0 6px">${escHtml(eyebrow)}</div>
</td></tr>
<tr><td style="padding:0 24px 22px;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#E8EAE6">${bodyHtml}${btn}</td></tr>
${footerHtml ? `<tr><td style="padding:18px 24px 22px;border-top:1px solid #2a2930;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#B9BCB7">${footerHtml}</td></tr>` : ''}
</table>
<div style="font-family:Arial,sans-serif;font-size:11px;color:#55585A;margin-top:12px">Common Ground · construction, in one place</div>
</td></tr></table></body></html>`;
}

// ── invites (shared by auth + hiring) ──
export async function createInvite(project, role, name, identifier, by, days = 14) {
  const t = token(24);
  const oldTok = await redis(['GET', `cg:invitefor:${project}:${identifier}`]);
  if (oldTok) await redis(['DEL', `cg:invite:${oldTok}`]);
  await setJSON(`cg:invite:${t}`, { project, role, name, identifier, by, at: new Date().toISOString() }, days * 86400);
  await redis(['SET', `cg:invitefor:${project}:${identifier}`, t, 'EX', String(days * 86400)]);
  return t;
}
export async function addMember(project, identifier, entry) {
  const prev = await redis(['HGET', `cg:members:${project}`, identifier]);
  const merged = Object.assign(prev ? JSON.parse(prev) : {}, entry, { identifier });
  await redis(['HSET', `cg:members:${project}`, identifier, JSON.stringify(merged)]);
  return merged;
}
export async function projectMembers(project) {
  const flat = (await redis(['HGETALL', `cg:members:${project}`])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out;
}

export async function recentNotifications(project, role, limit = 30) {
  const raw = (await redis(['LRANGE', `cg:notify:${project}`, '0', '60'])) || [];
  const out = [];
  for (const r of raw) {
    try { const n = JSON.parse(r); if (n.targets.includes(role)) { delete n.byAccount; out.push(n); } } catch (e) {}
    if (out.length >= limit) break;
  }
  return out;
}
