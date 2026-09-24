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
export const PROJECTS = ['anita'];                 // add new project slugs here
export const ROLES = ['client', 'gc', 'trade'];
export const validProject = (p) => PROJECTS.includes(p);

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
  return u || null;
}
// public shape sent to the browser (never the hash)
export const publicUser = (u) => u && ({ name: u.name, identifier: u.identifier, admin: !!u.admin, projects: u.projects || {} });

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
const PROJECT_TITLES = { anita: '141 N Anita' };
export async function notify(req, project, n) {
  const item = { id: token(8), at: new Date().toISOString(), text: clean(n.text, 300), targets: n.targets || ['gc'],
                 decision: n.decision || '', by: n.by || '', byAccount: n.byAccount || '' };
  await redis(['LPUSH', `cg:notify:${project}`, JSON.stringify(item)]);
  await redis(['LTRIM', `cg:notify:${project}`, '0', '199']);
  await sendEmails(req, project, item).catch(() => {});
  return item;
}
async function sendEmails(req, project, item) {
  const key = process.env.RESEND_API_KEY, from = process.env.CG_NOTIFY_FROM;
  if (!key || !from) return;
  const flat = (await redis(['HGETALL', `cg:members:${project}`])) || [];
  const byRole = {};
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const m = JSON.parse(flat[i + 1]);
      if (m.status !== 'active' || !m.identifier.includes('@') || m.identifier === item.byAccount) continue;
      if (!item.targets.includes(m.role)) continue;
      (byRole[m.role] = byRole[m.role] || []).push(m.identifier);
    } catch (e) {}
  }
  const host = `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  for (const role of Object.keys(byRole)) {
    const link = `${host}/${project}/${role}`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: byRole[role],
        subject: `${PROJECT_TITLES[project] || project}: ${item.text}`.slice(0, 150),
        text: `${item.text}\n\nOpen the project: ${link}\n\n— Common Ground`,
      }),
    });
    if (r.ok) await trackUsage('emails', byRole[role].length);
  }
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
