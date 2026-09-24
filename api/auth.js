// Common Ground — accounts: first-admin setup, sign in/out, invites, members.
import {
  storageReady, redis, getJSON, setJSON, clean, validProject, ROLES, normalizeIdentifier,
  hashPassword, verifyPassword, passwordProblem, token, createSession, destroySession,
  currentUser, publicUser, rateLimited, ip, trackUsage, monthKey, PROJECTS,
} from './_lib.js';

const INVITE_DAYS = 14;
const origin = (req) => `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
const canManage = (u, project) => !!u && (u.admin || (u.projects || {})[project] === 'gc');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storageReady()) return res.status(503).json({ error: 'storage_not_configured' });
  const q = req.query || {};
  const b = req.method === 'POST' ? (req.body || {}) : {};
  const action = clean(req.method === 'GET' ? q.action : b.action, 30);
  await trackUsage();

  try {
    // ── who am I
    if (req.method === 'GET' && action === 'me') {
      const u = await currentUser(req);
      const adminExists = !!(await redis(['GET', 'cg:admin:exists']));
      return res.status(200).json({ ok: true, user: publicUser(u), adminExists });
    }

    // ── look up an invite (to show "Welcome, Name")
    if (req.method === 'GET' && action === 'invite') {
      const inv = await getJSON(`cg:invite:${clean(q.token, 80)}`);
      if (!inv) return res.status(404).json({ error: 'invite_invalid' });
      const existing = await getJSON(`cg:user:${inv.identifier}`);
      return res.status(200).json({ ok: true, invite: { name: inv.name, identifier: inv.identifier, role: inv.role, project: inv.project, hasAccount: !!existing } });
    }

    // ── members list (GC / admin)
    if (req.method === 'GET' && action === 'members') {
      const project = clean(q.project, 40);
      const u = await currentUser(req);
      if (!validProject(project) || !canManage(u, project)) return res.status(403).json({ error: 'forbidden' });
      const flat = (await redis(['HGETALL', `cg:members:${project}`])) || [];
      const members = [];
      for (let i = 0; i < flat.length; i += 2) { try { members.push(JSON.parse(flat[i + 1])); } catch (e) {} }
      return res.status(200).json({ ok: true, members });
    }

    // ── platform usage + upgrade alerts (admin only)
    if (req.method === 'GET' && action === 'stats') {
      const u = await currentUser(req);
      if (!u || !u.admin) return res.status(403).json({ error: 'forbidden' });
      const flat = (await redis(['HGETALL', `cg:usage:${monthKey()}`])) || [];
      const usage = {}; for (let i = 0; i < flat.length; i += 2) usage[flat[i]] = Number(flat[i + 1]) || 0;
      let members = 0; for (const p of PROJECTS) members += Number(await redis(['HLEN', `cg:members:${p}`])) || 0;
      const keys = Number(await redis(['DBSIZE'])) || 0;
      const requests = usage.requests || 0, emails = usage.emails || 0;
      const limits = { commands: 500000, invocations: 1000000, membersSoft: 50, emails: 3000 };
      // days elapsed → projected month-end
      const now = new Date(); const day = now.getUTCDate(); const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const estCommands = requests * 4;
      const proj = (v) => Math.round(v / Math.max(day, 1) * dim);
      const alerts = [];
      if ((process.env.CG_VERCEL_PLAN || '').toLowerCase() !== 'pro')
        alerts.push({ level: 'soon', text: 'Vercel Hobby is for non-commercial use. Move to Vercel Pro ($20/mo) before homeowners on paid jobs rely on this, then set CG_VERCEL_PLAN=pro to clear this note.' });
      if (proj(estCommands) >= limits.commands * 0.8) alerts.push({ level: 'now', text: `Database on pace for ~${proj(estCommands).toLocaleString()} commands this month (free limit 500K). Switch Upstash to Pay-as-you-go now (about $0.20 per 100K).` });
      else if (proj(estCommands) >= limits.commands * 0.6) alerts.push({ level: 'soon', text: 'Database usage is past 60% of the free tier pace. Plan to switch Upstash to Pay-as-you-go.' });
      if (proj(requests) >= limits.invocations * 0.7) alerts.push({ level: 'soon', text: 'Server requests are trending toward the Vercel Hobby limit. Vercel Pro covers this.' });
      if (emails >= limits.emails * 0.6) alerts.push({ level: emails >= limits.emails * 0.85 ? 'now' : 'soon', text: `Email notifications: ${emails.toLocaleString()} of 3,000 free this month. Resend Pro is $20/mo for 50K.` });
      if (members >= 40) alerts.push({ level: 'soon', text: 'Approaching 50 people with access. Time to move sign-in to a full auth provider (self-serve password reset, 2-factor).' });
      return res.status(200).json({ ok: true, month: monthKey(), requests, estCommands, emails, members, keys, limits, alerts });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // ── one-time first admin (Ben) — needs CG_ADMIN_SETUP_CODE from Vercel env
    if (action === 'setup') {
      if (await redis(['GET', 'cg:admin:exists'])) return res.status(409).json({ error: 'admin_exists' });
      const code = process.env.CG_ADMIN_SETUP_CODE || '';
      if (!code || clean(b.code, 100) !== code) return res.status(401).json({ error: 'bad_setup_code' });
      const identifier = normalizeIdentifier(b.identifier);
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      const pp = passwordProblem(b.password); if (pp) return res.status(400).json({ error: 'weak_password', message: pp });
      const name = clean(b.name, 80) || 'GC';
      const user = { name, identifier, hash: hashPassword(b.password), admin: true, projects: { anita: 'gc' }, createdAt: new Date().toISOString() };
      await setJSON(`cg:user:${identifier}`, user);
      await redis(['SET', 'cg:admin:exists', identifier]);
      await redis(['HSET', 'cg:members:anita', identifier, JSON.stringify({ name, identifier, role: 'gc', status: 'active', admin: true })]);
      await createSession(req, res, identifier);
      return res.status(200).json({ ok: true, user: publicUser(user) });
    }

    // ── sign in
    if (action === 'login') {
      const identifier = normalizeIdentifier(b.identifier);
      if (!identifier || typeof b.password !== 'string') return res.status(400).json({ error: 'bad_login' });
      if (await rateLimited(`cg:rl:login:${identifier}`, 10, 900) || await rateLimited(`cg:rl:ip:${ip(req)}`, 40, 900)) {
        return res.status(429).json({ error: 'too_many_attempts' });
      }
      const u = await getJSON(`cg:user:${identifier}`);
      if (!u || !verifyPassword(b.password, u.hash)) return res.status(401).json({ error: 'bad_login' });
      await createSession(req, res, identifier);
      return res.status(200).json({ ok: true, user: publicUser(u) });
    }

    if (action === 'logout') {
      await destroySession(req, res);
      return res.status(200).json({ ok: true });
    }

    // ── accept an invite: set password (new account, or reset) and join the project
    if (action === 'accept') {
      const t = clean(b.token, 80);
      const inv = await getJSON(`cg:invite:${t}`);
      if (!inv) return res.status(404).json({ error: 'invite_invalid' });
      const pp = passwordProblem(b.password); if (pp) return res.status(400).json({ error: 'weak_password', message: pp });
      const existing = await getJSON(`cg:user:${inv.identifier}`);
      const user = existing || { name: inv.name, identifier: inv.identifier, admin: false, projects: {}, createdAt: new Date().toISOString() };
      user.hash = hashPassword(b.password);
      user.projects = Object.assign({}, user.projects, { [inv.project]: user.admin ? 'gc' : inv.role });
      if (clean(b.name, 80)) user.name = clean(b.name, 80);
      await setJSON(`cg:user:${inv.identifier}`, user);
      await redis(['DEL', `cg:invite:${t}`]);
      await redis(['DEL', `cg:invitefor:${inv.project}:${inv.identifier}`]);
      await redis(['HSET', `cg:members:${inv.project}`, inv.identifier, JSON.stringify({ name: user.name, identifier: inv.identifier, role: inv.role, status: 'active', joinedAt: new Date().toISOString() })]);
      await createSession(req, res, inv.identifier);
      return res.status(200).json({ ok: true, user: publicUser(user), project: inv.project, role: user.projects[inv.project] });
    }

    // ── invite someone (GC / admin) — also used to reset a password
    if (action === 'invite') {
      const u = await currentUser(req);
      const project = clean(b.project, 40);
      const role = clean(b.role, 10);
      if (!validProject(project) || !canManage(u, project)) return res.status(403).json({ error: 'forbidden' });
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'bad_role' });
      const identifier = normalizeIdentifier(b.identifier);
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      const name = clean(b.name, 80);
      if (!name) return res.status(400).json({ error: 'name_required' });
      const t = token(24);
      const oldTok = await redis(['GET', `cg:invitefor:${project}:${identifier}`]);
      if (oldTok) await redis(['DEL', `cg:invite:${oldTok}`]);
      await setJSON(`cg:invite:${t}`, { project, role, name, identifier, by: u.identifier, at: new Date().toISOString() }, INVITE_DAYS * 86400);
      await redis(['SET', `cg:invitefor:${project}:${identifier}`, t, 'EX', String(INVITE_DAYS * 86400)]);
      const prev = await redis(['HGET', `cg:members:${project}`, identifier]);
      const status = prev ? (JSON.parse(prev).status === 'active' ? 'active' : 'invited') : 'invited';
      await redis(['HSET', `cg:members:${project}`, identifier, JSON.stringify({ name, identifier, role, status, invitedAt: new Date().toISOString() })]);
      return res.status(200).json({ ok: true, link: `${origin(req)}/${project}/${role}?invite=${t}`, expiresInDays: INVITE_DAYS });
    }

    // ── remove someone from a project (GC / admin)
    if (action === 'remove') {
      const u = await currentUser(req);
      const project = clean(b.project, 40);
      if (!validProject(project) || !canManage(u, project)) return res.status(403).json({ error: 'forbidden' });
      const identifier = normalizeIdentifier(b.identifier);
      if (!identifier || identifier === u.identifier) return res.status(400).json({ error: 'bad_identifier' });
      await redis(['HDEL', `cg:members:${project}`, identifier]);
      const pendTok = await redis(['GET', `cg:invitefor:${project}:${identifier}`]);
      if (pendTok) { await redis(['DEL', `cg:invite:${pendTok}`]); await redis(['DEL', `cg:invitefor:${project}:${identifier}`]); }
      const target = await getJSON(`cg:user:${identifier}`);
      if (target && target.projects) { delete target.projects[project]; await setJSON(`cg:user:${identifier}`, target); }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err.message || err).slice(0, 200) });
  }
}

