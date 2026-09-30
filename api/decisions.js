// Common Ground — live decisions (contract approvals, change orders, discussion threads)
// Identity comes from the signed-in session (see api/auth.js). Only the project's
// owner account (role "client") can approve. GC (or admin) creates/revises change orders.
import { storageReady, redis, clean, validProject, currentUser, roleFor, ip, trackUsage, notify, recentNotifications } from './_lib.js';

function stripAudit(d) {
  (d.events || []).forEach((e) => { delete e.ip; delete e.ua; delete e.account; });
  if (d.approval) { delete d.approval.ip; delete d.approval.ua; delete d.approval.account; }
  return d;
}
// photos on decisions (GC or homeowner attach them; everyone but trades can view). Stored downsized by the browser.
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_B64 = 1400000, MAX_PHOTOS = 6;
async function savePhoto(project, p) {
  const type = clean(p && p.type, 30), data = p && typeof p.data === 'string' ? p.data : '';
  if (!PHOTO_TYPES.includes(type) || !data || data.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  const id = 'ph' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await redis(['SET', `cg:dphoto:${project}:${id}`, JSON.stringify({ type, data })]);
  return id;
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const project = clean((req.method === 'GET' ? req.query.project : req.body?.project) || '', 60).toLowerCase();
  if (!(await validProject(project))) return res.status(400).json({ error: 'bad_project' });
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
    if (req.method === 'GET' && req.query.action === 'photo') {
      const raw = await redis(['GET', `cg:dphoto:${project}:${clean(req.query.photo, 40)}`]);
      if (!raw) return res.status(404).json({ error: 'not_found' });
      const ph = JSON.parse(raw);
      res.setHeader('Content-Type', ph.type); res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.status(200).send(Buffer.from(ph.data, 'base64'));
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
    if (['approve', 'reject', 'void'].includes(action) && (u.projects || {})[project] !== 'client') return res.status(403).json({ error: 'owner_only' });
    if (action === 'withdraw' && role !== 'gc') return res.status(403).json({ error: 'gc_only' });
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
            createdBy: u.name, createdAt: ev.at, events: [{ type: 'created', amount: num(b.amount), note: clean(b.desc, 1000), ...ev }], photos: [] };
      for (const p of (Array.isArray(b.photos) ? b.photos.slice(0, 3) : [])) { const pid = await savePhoto(project, p); if (pid) d.photos.push({ id: pid, by: u.name, at: ev.at }); }
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
      if (d.status === 'pending') d.status = 'discussing';
      d.events.push({ type: 'comment', note, ...ev });
    } else if (action === 'reject' || action === 'void' || action === 'withdraw') {
      // owner has final say: reject a pending item or void their own approval; the GC can withdraw its own change order
      const note = clean(b.note, 1000);
      if (note.length < 3) return res.status(400).json({ error: 'reason_required' });
      if (action === 'void') {
        if (d.status !== 'approved') return res.status(409).json({ error: 'not_approved' });
        d.events.push({ type: 'voided', note, voidedRef: d.approval && d.approval.ref, ...ev });
        d.voidedApproval = d.approval; delete d.approval; d.status = 'pending';
      } else {
        if (d.status === 'approved') return res.status(409).json({ error: 'already_approved', decision: d });
        if (action === 'withdraw' && d.type !== 'co') return res.status(400).json({ error: 'not_change_order' });
        d.status = action === 'reject' ? 'rejected' : 'withdrawn';
        d.events.push({ type: d.status, note, ...ev });
      }
    } else if (action === 'add-photo') {
      if (role === 'trade') return res.status(403).json({ error: 'not_allowed' });
      d.photos = d.photos || [];
      if (d.photos.length >= MAX_PHOTOS) return res.status(409).json({ error: 'too_many_photos' });
      const pid = await savePhoto(project, b.photo);
      if (!pid) return res.status(400).json({ error: 'bad_photo' });
      d.photos.push({ id: pid, by: u.name, at: ev.at });
      d.events.push({ type: 'photo', note: clean(b.note, 200), ...ev });
    } else if (action === 'reopen') {
      if (!['rejected', 'withdrawn'].includes(d.status)) return res.status(409).json({ error: 'not_closed' });
      d.status = 'pending'; d.events.push({ type: 'reopened', note: clean(b.note, 1000), ...ev });
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
      : action === 'reject' ? { text: `${u.name} (Owner) rejected: ${d.title} — ${clean(b.note, 140)}`, targets: ['gc'] }
      : action === 'void' ? { text: `${u.name} (Owner) voided their approval: ${d.title} — ${clean(b.note, 140)}`, targets: ['gc'] }
      : action === 'withdraw' ? { text: `Change order withdrawn: ${d.title} — ${clean(b.note, 140)}`, targets: ['client'] }
      : action === 'add-photo' ? { text: `${u.name} added a photo to "${d.title}"`, targets: role === 'gc' ? ['client'] : ['gc'] }
      : action === 'reopen' ? { text: `Reopened for review: ${d.title}`, targets: role === 'gc' ? ['client'] : ['gc'] }
      : action === 'comment' ? { text: `${u.name} (${who}) on "${d.title}": ${clean(b.note, 140)}`, targets: role === 'gc' ? ['client'] : ['gc'] }
      : null;
    if (n) await notify(req, project, Object.assign(n, { decision: d.id, by: u.name, byAccount: u.identifier }));
    return res.status(200).json({ ok: true, decision: role === 'gc' ? d : stripAudit(JSON.parse(JSON.stringify(d))) });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err.message || err).slice(0, 200) });
  }
}
