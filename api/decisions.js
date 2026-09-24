// Common Ground — live decisions (contract approvals, change orders, discussion threads)
// Identity comes from the signed-in session (see api/auth.js). Only the project's
// owner account (role "client") can approve. GC (or admin) creates/revises change orders.
import { storageReady, redis, clean, validProject, currentUser, roleFor, ip, trackUsage, notify, recentNotifications } from './_lib.js';

function stripAudit(d) {
  (d.events || []).forEach((e) => { delete e.ip; delete e.ua; delete e.account; });
  if (d.approval) { delete d.approval.ip; delete d.approval.ua; delete d.approval.account; }
  return d;
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const project = clean((req.method === 'GET' ? req.query.project : req.body?.project) || '', 40).toLowerCase();
  if (!validProject(project)) return res.status(400).json({ error: 'bad_project' });
  if (!storageReady()) return res.status(503).json({ error: 'storage_not_configured' });

  await trackUsage();
  const u = await currentUser(req);
  const role = roleFor(u, project);                      // admin → 'gc'
  if (!u || !role) return res.status(401).json({ error: 'sign_in_required' });
  const key = `cg:decisions:${project}`;

  try {
    if (role === 'trade') {
      // trades don't see owner contracts / change-order pricing
      if (req.method === 'GET') return res.status(200).json({ ok: true, live: true, role, decisions: [], notifications: [] });
      return res.status(403).json({ error: 'not_allowed' });
    }
    if (req.method === 'GET') {
      const flat = (await redis(['HGETALL', key])) || [];
      const decisions = [];
      for (let i = 0; i < flat.length; i += 2) { try { decisions.push(JSON.parse(flat[i + 1])); } catch (e) {} }
      if (role !== 'gc') {
        // device details are for the GC's audit trail only
        decisions.forEach(stripAudit);
      }
      const notifications = await recentNotifications(project, role);
      return res.status(200).json({ ok: true, live: true, role, decisions, notifications });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const b = req.body || {};
    const action = clean(b.action, 20);
    let id = action === 'create' ? 'co-' + Date.now().toString(36) : clean(b.id, 60);
    if (!/^[a-z0-9-]{1,60}$/.test(id)) return res.status(400).json({ error: 'bad_id' });

    // permission checks before anything is looked up or stored
    if (action === 'approve' && (u.projects || {})[project] !== 'client') return res.status(403).json({ error: 'owner_only' });
    if ((action === 'create' || action === 'revise') && role !== 'gc') return res.status(403).json({ error: 'gc_only' });

    const raw = await redis(['HGET', key, id]);
    let d = raw ? JSON.parse(raw) : null;
    if (!d && action !== 'create') {
      const s = b.snapshot || {};
      if (!clean(s.title)) return res.status(404).json({ error: 'unknown_decision' });
      d = { id, type: clean(s.type, 20) || 'decision', title: clean(s.title, 160), area: clean(s.area, 80), amount: num(s.amount),
            desc: clean(s.desc, 1000), status: 'pending', createdBy: 'system', createdAt: new Date().toISOString(), events: [] };
    }

    const ev = { by: u.name, account: u.identifier, role, at: new Date().toISOString(), ip: ip(req), ua: clean(req.headers['user-agent'] || '', 200) };

    if (action === 'create') {
      if (role !== 'gc') return res.status(403).json({ error: 'gc_only' });
      const title = clean(b.title, 160);
      if (!title) return res.status(400).json({ error: 'title_required' });
      d = { id, type: 'co', title, area: clean(b.area, 80), amount: num(b.amount), desc: clean(b.desc, 1000), status: 'pending',
            createdBy: u.name, createdAt: ev.at, events: [{ type: 'created', amount: num(b.amount), note: clean(b.desc, 1000), ...ev }] };
    } else if (action === 'approve') {
      // Owner account only — an admin previewing the client view cannot sign for the owner.
      if ((u.projects || {})[project] !== 'client') return res.status(403).json({ error: 'owner_only' });
      if (d.status === 'approved') return res.status(409).json({ error: 'already_approved', decision: d });
      if (b.agree !== true) return res.status(400).json({ error: 'agreement_required' });
      const signature = clean(b.signature, 80);
      if (signature.length < 3) return res.status(400).json({ error: 'signature_required' });
      const ref = 'CG-' + project.toUpperCase().slice(0, 6) + '-' + Date.now().toString(36).toUpperCase();
      d.status = 'approved';
      d.approval = { signature, amount: d.amount, ref, ...ev };
      d.events.push({ type: 'approved', signature, amount: d.amount, ref, ...ev });
    } else if (action === 'comment') {
      const note = clean(b.note, 1000);
      if (!note) return res.status(400).json({ error: 'note_required' });
      if (d.status !== 'approved') d.status = 'discussing';
      d.events.push({ type: 'comment', note, ...ev });
    } else if (action === 'revise') {
      if (role !== 'gc') return res.status(403).json({ error: 'gc_only' });
      if (d.status === 'approved') return res.status(409).json({ error: 'already_approved', decision: d });
      const amount = num(b.amount);
      if (amount !== null) d.amount = amount;
      d.status = 'pending';
      d.events.push({ type: 'revised', amount: d.amount, note: clean(b.note, 1000), ...ev });
    } else {
      return res.status(400).json({ error: 'bad_action' });
    }

    d.updatedAt = ev.at;
    await redis(['HSET', key, id, JSON.stringify(d)]);

    // who hears about it
    const money = d.amount != null ? ` · $${Math.round(d.amount).toLocaleString('en-US')}` : '';
    const who = role === 'client' ? 'Owner' : role === 'gc' ? 'GC' : 'Trade';
    const n = action === 'approve' ? { text: `${u.name} (Owner) approved: ${d.title}${money} · ref ${d.approval.ref}`, targets: ['gc'] }
      : action === 'create' ? { text: `New change order to review: ${d.title}${money}`, targets: ['client'] }
      : action === 'revise' ? { text: `Change order revised: ${d.title}${money}`, targets: ['client'] }
      : action === 'comment' ? { text: `${u.name} (${who}) on "${d.title}": ${clean(b.note, 140)}`, targets: role === 'gc' ? ['client'] : ['gc'] }
      : null;
    if (n) await notify(req, project, Object.assign(n, { decision: d.id, by: u.name, byAccount: u.identifier }));
    return res.status(200).json({ ok: true, decision: role === 'gc' ? d : stripAudit(JSON.parse(JSON.stringify(d))) });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err.message || err).slice(0, 200) });
  }
}
