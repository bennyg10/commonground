// Common Ground — master platform console (platform admin only).
//   GET  /admin                       → console page (or sign-in)
//   GET  /api/admin?action=overview   → every project, person, bid, decision, activity, help request
//   POST /api/admin {action, ...}     → controls (roles, access, passwords, stages, decisions)
// Owner signatures stay the owner's: the console can void an approval or record a
// paper-signed one (clearly labelled), but never signs in the owner's name.
import fs from 'node:fs';
import path from 'node:path';
import {
  storageReady, redis, getJSON, setJSON, clean, validProject, ROLES, PROJECTS, PROJECT_NAMES, normalizeIdentifier,
  createSession, currentUser, publicUser, trackUsage, notify, createInvite, addMember, projectMembers, siteOrigin, indexUser, canonicalRedirect,
} from './_lib.js';
import { seedProject } from './project.js';

const now = () => new Date().toISOString();
const STAGES = ['bidding', 'kickoff', 'active'];
const safeJSON = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const cache = {};
const readPage = (n) => (cache[n] = cache[n] || fs.readFileSync(path.join(process.cwd(), 'api', '_pages', n), 'utf8'));
function sendPage(res, name, varName, data, status = 200) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(status).send(readPage(name).replace('</head>', `<script>window.${varName}=${safeJSON(data)};</script>\n</head>`));
}
async function hashList(key) {
  const flat = (await redis(['HGETALL', key])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out;
}
const publicAccount = (u) => ({
  identifier: u.identifier, name: u.name, admin: !!u.admin, disabled: !!u.disabled, projects: u.projects || {},
  phone: u.phone || '', createdAt: u.createdAt || '', bids: u.bids || {}, sessionsValidAfter: u.sessionsValidAfter || '',
});

// Contract decisions the project page shows before anyone has acted on them (mirrors decSeedsForStage in the app)
function seedDecisions(p, state) {
  const h = state.hiredGc;
  if (!h) return [];
  const base = { status: 'pending', events: [], seed: true };
  if (p === 'anita' && h.bidId === 'bid-trujillo') return [
    Object.assign({ id: 'p1-contract', type: 'contract', area: 'Phase 1 · Contract', title: 'Phase 1 contract — demolition + site clearing', amount: 136700 }, base),
    Object.assign({ id: 'p1-gc-option', type: 'contract', area: 'Phase 1 · GC', title: 'Option 2 — GC overhead + management', amount: 16500 }, base),
    Object.assign({ id: 'soil-allowance', type: 'allowance', area: 'Grading · Hauling', title: 'Extra soil hauling allowance — $1,500 / load', amount: null }, base),
  ];
  const who = h.company || h.name;
  return [Object.assign({ id: 'contract-' + h.bidId, type: 'contract', area: 'Contract · ' + who, title: 'Construction contract — ' + who, amount: h.amount || null }, base)];
}

async function projectSnapshot(p) {
  const state = (await getJSON(`cg:project:${p}`)) || { stage: 'bidding', hiredGc: null, startedAt: null };
  const members = await projectMembers(p);
  const bids = (await hashList(`cg:bids:${p}`)).sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
  const stored = await hashList(`cg:decisions:${p}`);
  const decisions = seedDecisions(p, state).filter((s) => !stored.some((d) => d.id === s.id)).concat(stored);
  const kickoff = (await getJSON(`cg:kickoff:${p}`)) || { items: [] };
  const items = kickoff.items || [];
  const done = (i) => (i.type === 'agreement' ? i.gcAgreed && i.clientAgreed : i.done);
  const activity = ((await redis(['LRANGE', `cg:notify:${p}`, '0', '39'])) || [])
    .map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
  return {
    slug: p, name: PROJECT_NAMES[p] || p, stage: state.stage, hiredGc: state.hiredGc || null, startedAt: state.startedAt || null,
    members, bids, decisions,
    kickoff: { total: items.length, done: items.filter(done).length, open: items.filter((i) => i.required && !done(i)).map((i) => i.text) },
    activity,
  };
}

async function allAccounts(projects) {
  const ids = new Set((await redis(['SMEMBERS', 'cg:users'])) || []);
  const first = await redis(['GET', 'cg:admin:exists']); if (first) ids.add(first);
  for (const pr of projects) {
    pr.members.forEach((m) => ids.add(m.identifier));
    pr.bids.forEach((b) => { if (b.account) ids.add(b.account); });
  }
  const accounts = [];
  for (const id of ids) {
    const u = await getJSON(`cg:user:${id}`);
    if (u) { accounts.push(publicAccount(u)); await indexUser(id); }   // self-heal the index for pre-console accounts
  }
  return accounts.sort((a, b) => (b.admin - a.admin) || String(a.name).localeCompare(String(b.name)));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const b = req.method === 'POST' ? (req.body || {}) : {};
  const action = clean(req.method === 'GET' ? q.action : b.action, 30);

  // ── the console page itself
  if (req.method === 'GET' && !action) {
    if (canonicalRedirect(req, res, '/admin')) return;
    const loginData = (message, extra) => Object.assign({ project: 'anita', role: '', invite: '', message: message || '', storage: storageReady(), next: '/admin', adminPage: true }, extra || {});
    if (!storageReady()) return sendPage(res, 'login.html', 'CG_LOGIN', loginData('Sign-in isn\'t connected yet. The database needs to be set up in Vercel.'));
    await trackUsage();
    const u = await currentUser(req);
    const adminExists = !!(await redis(['GET', 'cg:admin:exists']));
    if (!u) return sendPage(res, 'login.html', 'CG_LOGIN', loginData('', { adminExists }));
    if (!u.admin) return sendPage(res, 'login.html', 'CG_LOGIN', loginData('The platform console is for the platform admin only.', { adminExists, signedIn: publicUser(u) }), 403);
    return sendPage(res, 'admin.html', 'CG_ADMIN', { me: publicUser(u), projects: PROJECTS.map((p) => ({ slug: p, name: PROJECT_NAMES[p] || p })) });
  }

  if (!storageReady()) return res.status(503).json({ error: 'storage_not_configured' });
  await trackUsage();
  const me = await currentUser(req);
  if (!me) return res.status(401).json({ error: 'sign_in_required' });
  if (!me.admin) return res.status(403).json({ error: 'admin_only' });

  try {
    if (req.method === 'GET' && action === 'overview') {
      const projects = [];
      for (const p of PROJECTS) { await seedProject(p); projects.push(await projectSnapshot(p)); }
      const accounts = await allAccounts(projects);
      const support = ((await redis(['LRANGE', 'cg:support', '0', '49'])) || []).map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
      const supportTotal = Number(await redis(['LLEN', 'cg:support'])) || 0;
      return res.status(200).json({ ok: true, me: publicUser(me), projects, accounts, support, supportTotal, at: now() });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const project = clean(b.project, 40).toLowerCase();
    const needProject = () => validProject(project);
    const identifier = normalizeIdentifier(b.identifier);
    const self = identifier && identifier === me.identifier;
    const log = (text, targets = ['gc']) => notify(req, project, { text, targets, by: me.name, byAccount: me.identifier, noEmail: true });

    // ── people & access ──
    if (action === 'invite') {
      const role = clean(b.role, 10), name = clean(b.name, 80);
      if (!needProject()) return res.status(400).json({ error: 'bad_project' });
      if (!ROLES.includes(role)) return res.status(400).json({ error: 'bad_role' });
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      if (!name) return res.status(400).json({ error: 'name_required' });
      const t = await createInvite(project, role, name, identifier, me.identifier);
      const prev = (await projectMembers(project)).find((m) => m.identifier === identifier);
      await addMember(project, identifier, { name, role, status: prev && prev.status === 'active' ? 'active' : 'invited', invitedAt: now() });
      return res.status(200).json({ ok: true, link: `${siteOrigin(req)}/${project}/${role}?invite=${t}`, expiresInDays: 14 });
    }

    if (action === 'set-role') {
      const role = clean(b.role, 10);
      if (!needProject() || !ROLES.includes(role) || !identifier) return res.status(400).json({ error: 'bad_request' });
      const u = await getJSON(`cg:user:${identifier}`);
      const member = (await projectMembers(project)).find((m) => m.identifier === identifier);
      if (!u && !member) return res.status(404).json({ error: 'not_found' });
      if (u) { u.projects = Object.assign({}, u.projects, { [project]: role }); await setJSON(`cg:user:${identifier}`, u); }
      await addMember(project, identifier, { name: (u && u.name) || member.name, role, status: u ? 'active' : (member.status || 'invited') });
      const pend = await redis(['GET', `cg:invitefor:${project}:${identifier}`]);
      if (pend) { const inv = await getJSON(`cg:invite:${pend}`); if (inv) { inv.role = role; await setJSON(`cg:invite:${pend}`, inv, 14 * 86400); } }
      return res.status(200).json({ ok: true });
    }

    if (action === 'remove') {
      if (!needProject() || !identifier) return res.status(400).json({ error: 'bad_request' });
      if (self) return res.status(400).json({ error: 'not_yourself' });
      await redis(['HDEL', `cg:members:${project}`, identifier]);
      const pend = await redis(['GET', `cg:invitefor:${project}:${identifier}`]);
      if (pend) { await redis(['DEL', `cg:invite:${pend}`]); await redis(['DEL', `cg:invitefor:${project}:${identifier}`]); }
      const u = await getJSON(`cg:user:${identifier}`);
      if (u && u.projects) { delete u.projects[project]; await setJSON(`cg:user:${identifier}`, u); }
      return res.status(200).json({ ok: true });
    }

    if (action === 'reset-link') {
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      const u = await getJSON(`cg:user:${identifier}`);
      if (!u) return res.status(404).json({ error: 'not_found' });
      const entries = Object.entries(u.projects || {}).filter(([p]) => validProject(p));
      const [p, role] = entries.find(([pp]) => pp === project) || entries[0] || [PROJECTS[0], u.admin ? 'gc' : ''];
      if (!role) return res.status(409).json({ error: 'no_project_access' });
      const t = await createInvite(p, role, u.name, identifier, me.identifier, 2);
      return res.status(200).json({ ok: true, link: `${siteOrigin(req)}/${p}/${role}?invite=${t}`, expiresInDays: 2 });
    }

    if (action === 'signout-all') {
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      const u = await getJSON(`cg:user:${identifier}`);
      if (!u) return res.status(404).json({ error: 'not_found' });
      u.sessionsValidAfter = now();
      await setJSON(`cg:user:${identifier}`, u);
      if (self) await createSession(req, res, identifier);   // keep this browser signed in
      return res.status(200).json({ ok: true });
    }

    if (action === 'set-admin' || action === 'disable') {
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      if (self) return res.status(400).json({ error: 'not_yourself' });
      const u = await getJSON(`cg:user:${identifier}`);
      if (!u) return res.status(404).json({ error: 'not_found' });
      if (action === 'set-admin') u.admin = b.admin === true; else u.disabled = b.disabled === true;
      await setJSON(`cg:user:${identifier}`, u);
      return res.status(200).json({ ok: true, account: publicAccount(u) });
    }

    if (action === 'delete-user') {
      if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
      if (self) return res.status(400).json({ error: 'not_yourself' });
      if (clean(b.confirm, 120).toLowerCase() !== identifier) return res.status(400).json({ error: 'confirm_required' });
      for (const p of PROJECTS) {
        await redis(['HDEL', `cg:members:${p}`, identifier]);
        const pend = await redis(['GET', `cg:invitefor:${p}:${identifier}`]);
        if (pend) { await redis(['DEL', `cg:invite:${pend}`]); await redis(['DEL', `cg:invitefor:${p}:${identifier}`]); }
      }
      await redis(['DEL', `cg:user:${identifier}`]);
      await redis(['SREM', 'cg:users', identifier]);
      return res.status(200).json({ ok: true });
    }

    // ── project controls ──
    if (action === 'set-stage') {
      if (!needProject()) return res.status(400).json({ error: 'bad_project' });
      const stage = clean(b.stage, 20);
      if (!STAGES.includes(stage)) return res.status(400).json({ error: 'bad_stage' });
      const p = (await getJSON(`cg:project:${project}`)) || { stage: 'bidding', hiredGc: null, startedAt: null };
      if (stage !== 'bidding' && !p.hiredGc) return res.status(409).json({ error: 'no_gc_yet' });
      const next = Object.assign({}, p, { stage });
      if (stage === 'bidding') {
        if (p.hiredGc) {   // release the hire: bid goes back to "submitted", GC keeps their account but loses project access
          const raw = await redis(['HGET', `cg:bids:${project}`, p.hiredGc.bidId]);
          if (raw) { const bid = JSON.parse(raw); bid.status = 'submitted'; delete bid.decidedAt; delete bid.decidedBy; await redis(['HSET', `cg:bids:${project}`, bid.id, JSON.stringify(bid)]); }
          if (b.keepGcAccess !== true && p.hiredGc.identifier && p.hiredGc.identifier !== me.identifier) {
            const gu = await getJSON(`cg:user:${p.hiredGc.identifier}`);
            if (gu && gu.projects && gu.projects[project] === 'gc' && !gu.admin) { delete gu.projects[project]; await setJSON(`cg:user:${gu.identifier}`, gu); }
            await redis(['HDEL', `cg:members:${project}`, p.hiredGc.identifier]);
          }
        }
        next.hiredGc = null; next.startedAt = null;
        await redis(['DEL', `cg:kickoff:${project}`]);
      }
      if (stage === 'kickoff') next.startedAt = null;
      if (stage === 'active' && !next.startedAt) { next.startedAt = now(); next.startedBy = me.name; }
      await setJSON(`cg:project:${project}`, next);
      await log(`Platform admin set ${PROJECT_NAMES[project] || project} to "${stage}"`, ['gc']);
      return res.status(200).json({ ok: true, stage });
    }

    if (action === 'void-decision' || action === 'record-approval') {
      if (!needProject()) return res.status(400).json({ error: 'bad_project' });
      const id = clean(b.id, 60), reason = clean(b.reason, 500);
      const raw = await redis(['HGET', `cg:decisions:${project}`, id]);
      let d = raw ? JSON.parse(raw) : null;
      if (!d) {   // a contract the page shows but nobody has acted on yet
        const st = (await getJSON(`cg:project:${project}`)) || {};
        const seed = seedDecisions(project, st).find((x) => x.id === id);
        if (!seed) return res.status(404).json({ error: 'not_found' });
        d = Object.assign({}, seed, { createdBy: 'system', createdAt: now(), events: [] }); delete d.seed;
      }
      if (reason.length < 3) return res.status(400).json({ error: 'reason_required' });
      const ev = { by: me.name, account: me.identifier, role: 'admin', at: now() };
      if (action === 'void-decision') {
        if (d.status !== 'approved') return res.status(409).json({ error: 'not_approved' });
        d.events.push({ type: 'voided', note: reason, voidedRef: d.approval && d.approval.ref, ...ev });
        d.status = 'pending'; d.voidedApproval = d.approval; delete d.approval;
        await log(`Approval voided by platform admin: ${d.title} — ${reason}`, ['client', 'gc']);
      } else {
        if (d.status === 'approved') return res.status(409).json({ error: 'already_approved' });
        const signedBy = clean(b.signedBy, 80);
        if (signedBy.length < 3) return res.status(400).json({ error: 'signature_required' });
        const ref = 'CG-' + project.toUpperCase().slice(0, 6) + '-' + Date.now().toString(36).toUpperCase();
        d.status = 'approved';
        d.approval = { signature: signedBy, amount: d.amount, ref, method: 'offline', note: reason, recordedBy: me.name, ...ev };
        d.events.push({ type: 'approved', signature: signedBy, amount: d.amount, ref, method: 'offline', note: reason, ...ev });
        await log(`Paper approval recorded by platform admin: ${d.title} — signed by ${signedBy} · ref ${ref}`, ['client', 'gc']);
      }
      d.updatedAt = ev.at;
      await redis(['HSET', `cg:decisions:${project}`, id, JSON.stringify(d)]);
      return res.status(200).json({ ok: true, decision: d });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err.message || err).slice(0, 200) });
  }
}
