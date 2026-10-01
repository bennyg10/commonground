// Common Ground — project tools storage.
//   Saved results (code check, plan analysis):   cg:tools:<project>  (list, newest first, 30 kept)
//   3D scans (.glb / .usdz, up to 24 MB):     cg:scans:<project> (hash of metadata)
//                                                cg:scan:<id>:<n>   (base64 chunks, ~2.5 MB each)
// Chunks keep every request under Vercel's 4.5 MB body limit without extra services.
// Bigger files / heavy use → move scans to Vercel Blob (see usage panel).
import { storageReady, redis, getJSON, setJSON, clean, validProject, currentUser, roleFor, trackUsage, token, rateLimited, notify } from './_lib.js';

const MAX_SCAN_BYTES = 24 * 1024 * 1024;
const CHUNK_B64 = 2800000;                    // base64 chars per chunk (~2.1 MB)
const MAX_SCANS = 12;
const SCAN_EXT = ['glb', 'usdz'];
const TOOLS = ['codecheck', 'plans', 'crosscheck'];
const SCHED_STATUS = ['planned', 'in-progress', 'done', 'delayed'];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const now = () => new Date().toISOString();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storageReady()) return res.status(503).json({ error: 'storage_not_configured' });
  await trackUsage();
  const q = req.query || {};
  const b = req.method === 'POST' ? (req.body || {}) : {};
  const project = clean((req.method === 'GET' ? q.project : b.project) || '', 60).toLowerCase();
  const action = clean(req.method === 'GET' ? q.action : b.action, 30);
  if (!(await validProject(project))) return res.status(400).json({ error: 'bad_project' });
  const u = await currentUser(req);
  const role = roleFor(u, project);
  if (!u || !role) return res.status(401).json({ error: 'sign_in_required' });
  const canWrite = role === 'gc' || role === 'client' || role === 'designer';

  try {
    // ── saved tool results
    if (req.method === 'GET' && action === 'results') {
      if (role === 'trade') return res.status(200).json({ ok: true, results: [] });
      const raw = (await redis(['LRANGE', `cg:tools:${project}`, '0', '29'])) || [];
      return res.status(200).json({ ok: true, results: raw.map((r) => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean) });
    }
    if (req.method === 'POST' && action === 'save-result') {
      if (!canWrite) return res.status(403).json({ error: 'forbidden' });
      const tool = clean(b.tool, 20);
      if (!TOOLS.includes(tool)) return res.status(400).json({ error: 'bad_tool' });
      const result = b.result && typeof b.result === 'object' ? b.result : null;
      const json = JSON.stringify(result || {});
      if (!result || json.length > 120000) return res.status(400).json({ error: 'bad_result' });
      const item = { id: token(8), tool, title: clean(b.title, 160), fileName: clean(b.fileName, 160), jurisdiction: clean(b.jurisdiction, 120),
                     result, by: u.name, role, at: now() };
      await redis(['LPUSH', `cg:tools:${project}`, JSON.stringify(item)]);
      await redis(['LTRIM', `cg:tools:${project}`, '0', '29']);
      const label = tool === 'codecheck' ? 'Code check' : tool === 'crosscheck' ? 'Scan vs drawings cross-check' : 'Plan analysis';
      await notify(req, project, { text: `${label} saved: ${item.title || item.fileName || 'plans'}`, targets: role === 'gc' ? ['client'] : ['gc'], by: u.name, byAccount: u.identifier, noEmail: true });
      return res.status(200).json({ ok: true, item });
    }

    // ── measurements: taken on a 3D scan (3D or 2D plan view) or typed in by hand, grouped by room and wall
    if (req.method === 'GET' && action === 'measures') {
      return res.status(200).json({ ok: true, measures: (await getJSON(`cg:measure:${project}`)) || [] });
    }
    if (req.method === 'POST' && action === 'measure-add') {
      if (await rateLimited(`cg:rl:measure:${u.identifier}`, 400, 86400)) return res.status(429).json({ error: 'too_many_attempts' });
      const meters = Number(b.meters);
      if (!(meters > 0 && meters < 1000)) return res.status(400).json({ error: 'bad_length' });
      const room = clean(b.room, 60), label = clean(b.label, 80);
      if (!room) return res.status(400).json({ error: 'room_required' });
      const pt = (p) => (Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(Number(n))) ? p.map((n) => Math.round(Number(n) * 1000) / 1000) : null);
      const source = b.source === 'scan' ? 'scan' : 'manual';
      const scanId = source === 'scan' ? clean(b.scanId, 40) : '';
      if (source === 'scan' && !(await redis(['HGET', `cg:scans:${project}`, scanId]))) return res.status(404).json({ error: 'scan_not_found' });
      const m = { id: 'm' + Date.now().toString(36) + token(3).replace(/[^a-zA-Z0-9]/g, ''), room, label: label || 'Measurement', meters: Math.round(meters * 1000) / 1000,
                  source, scanId, view: b.view === '2d' ? '2d' : '3d', a: source === 'scan' ? pt(b.a) : null, b: source === 'scan' ? pt(b.b) : null,
                  note: clean(b.note, 200), by: u.name, account: u.identifier, role, at: now() };
      const list = (await getJSON(`cg:measure:${project}`)) || [];
      if (list.length >= 400) return res.status(409).json({ error: 'too_many_measures' });
      list.push(m); await setJSON(`cg:measure:${project}`, list);
      return res.status(200).json({ ok: true, measure: m, measures: list });
    }
    if (req.method === 'POST' && action === 'measure-delete') {
      const list = (await getJSON(`cg:measure:${project}`)) || [];
      const m = list.find((x) => x.id === clean(b.id, 40));
      if (!m) return res.status(404).json({ error: 'not_found' });
      if (!(m.account === u.identifier || role === 'gc' || role === 'client' || u.admin)) return res.status(403).json({ error: 'forbidden' });
      const next = list.filter((x) => x.id !== m.id); await setJSON(`cg:measure:${project}`, next);
      return res.status(200).json({ ok: true, measures: next });
    }

    // ── 3D scans
    if (req.method === 'GET' && action === 'scans') {
      const flat = (await redis(['HGETALL', `cg:scans:${project}`])) || [];
      const scans = [];
      for (let i = 0; i < flat.length; i += 2) { try { const s = JSON.parse(flat[i + 1]); if (s.ready) scans.push(s); } catch (e) {} }
      scans.sort((a, c) => (a.at < c.at ? 1 : -1));
      return res.status(200).json({ ok: true, scans, maxBytes: MAX_SCAN_BYTES });
    }
    if (req.method === 'GET' && action === 'scan-chunk') {
      const id = clean(q.id, 40), n = Number(q.n);
      const meta = await redis(['HGET', `cg:scans:${project}`, id]);
      if (!meta || !(n >= 0)) return res.status(404).json({ error: 'not_found' });
      const data = await redis(['GET', `cg:scan:${id}:${n}`]);
      if (!data) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.status(200).json({ ok: true, n, data });
    }
    // ── schedule (timeline) + tasks — everyone on the project sees them
    if (req.method === 'GET' && action === 'schedule') {
      return res.status(200).json({ ok: true, schedule: (await getJSON(`cg:schedule:${project}`)) || { items: [] }, tasks: (await getJSON(`cg:tasks:${project}`)) || { items: [] } });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    if (action === 'task-toggle') {
      const doc = (await getJSON(`cg:tasks:${project}`)) || { items: [] };
      const t = doc.items.find((x) => x.id === clean(b.id, 30));
      if (!t) return res.status(404).json({ error: 'not_found' });
      if (!(canWrite || t.assignee === u.identifier)) return res.status(403).json({ error: 'forbidden' });
      t.done = !t.done; t.doneBy = t.done ? u.name : ''; t.doneAt = t.done ? now() : '';
      await setJSON(`cg:tasks:${project}`, doc);
      if (t.done && t.createdByAccount && t.createdByAccount !== u.identifier) {
        const creatorRole = t.createdByRole === 'client' ? 'client' : 'gc';
        await notify(req, project, { text: `Task done: ${t.title} — ${u.name}`, targets: [creatorRole], by: u.name, byAccount: u.identifier, noEmail: true });
      }
      return res.status(200).json({ ok: true, tasks: doc });
    }
    if (!canWrite) return res.status(403).json({ error: 'forbidden' });

    if (action === 'schedule-save') {
      if (role === 'designer') return res.status(403).json({ error: 'forbidden' });   // the schedule is the GC's (and owner's)
      const items = Array.isArray(b.items) ? b.items.slice(0, 80) : null;
      if (!items) return res.status(400).json({ error: 'bad_request' });
      const clean_ = items.map((x, i) => ({
        id: clean(x.id, 30) || 'p' + Date.now().toString(36) + i, name: clean(x.name, 120), trade: clean(x.trade, 60),
        start: isDate(x.start) ? x.start : '', end: isDate(x.end) ? x.end : '', status: SCHED_STATUS.includes(x.status) ? x.status : 'planned', note: clean(x.note, 200),
      })).filter((x) => x.name);
      for (const x of clean_) if (x.start && x.end && x.end < x.start) return res.status(400).json({ error: 'end_before_start', item: x.name });
      const doc = { items: clean_, updatedAt: now(), by: u.name };
      await setJSON(`cg:schedule:${project}`, doc);
      await notify(req, project, { text: `Schedule updated by ${u.name} · ${clean_.length} phase${clean_.length === 1 ? '' : 's'}`, targets: role === 'gc' ? ['client', 'trade'] : ['gc'], by: u.name, byAccount: u.identifier, noEmail: true });
      return res.status(200).json({ ok: true, schedule: doc });
    }
    if (action === 'task-add') {
      const title = clean(b.title, 160);
      if (!title) return res.status(400).json({ error: 'title_required' });
      const doc = (await getJSON(`cg:tasks:${project}`)) || { items: [] };
      if (doc.items.length >= 300) return res.status(409).json({ error: 'too_many_tasks' });
      const t = { id: 't' + Date.now().toString(36) + token(3).replace(/[^a-zA-Z0-9]/g, ''), title, assignee: clean(b.assignee, 120), assigneeName: clean(b.assigneeName, 80),
                  due: isDate(b.due) ? b.due : '', priority: b.priority === 'high' ? 'high' : 'normal', done: false,
                  createdBy: u.name, createdByAccount: u.identifier, createdByRole: role, at: now() };
      doc.items.unshift(t);
      await setJSON(`cg:tasks:${project}`, doc);
      if (t.assignee && t.assignee !== u.identifier) await notify(req, project, { text: `New task for ${t.assigneeName || 'you'}: ${title}${t.due ? ' · due ' + t.due : ''}`, targets: ['trade', 'gc', 'client'].filter((r) => r !== role), by: u.name, byAccount: u.identifier, noEmail: true });
      return res.status(200).json({ ok: true, tasks: doc });
    }
    if (action === 'task-delete') {
      const doc = (await getJSON(`cg:tasks:${project}`)) || { items: [] };
      doc.items = doc.items.filter((x) => x.id !== clean(b.id, 30));
      await setJSON(`cg:tasks:${project}`, doc);
      return res.status(200).json({ ok: true, tasks: doc });
    }

    if (action === 'scan-init') {
      if (await rateLimited(`cg:rl:scan:${u.identifier}`, 20, 86400)) return res.status(429).json({ error: 'too_many_attempts' });
      const name = clean(b.name, 120) || 'scan';
      const ext = (name.split('.').pop() || '').toLowerCase();
      if (!SCAN_EXT.includes(ext)) return res.status(400).json({ error: 'bad_file_type' });
      const size = Number(b.size);
      if (!(size > 0) || size > MAX_SCAN_BYTES) return res.status(413).json({ error: 'file_too_large' });
      if ((Number(await redis(['HLEN', `cg:scans:${project}`])) || 0) >= MAX_SCANS) return res.status(409).json({ error: 'too_many_scans' });
      const id = 's' + Date.now().toString(36) + token(4).replace(/[^a-zA-Z0-9]/g, '');
      const chunks = Math.ceil((Math.ceil(size / 3) * 4) / CHUNK_B64);
      const meta = { id, name, ext, size, chunks, label: clean(b.label, 120) || name.replace(/\.[^.]+$/, ''), by: u.name, role, at: now(), ready: false, received: 0 };
      await redis(['HSET', `cg:scans:${project}`, id, JSON.stringify(meta)]);
      return res.status(200).json({ ok: true, id, chunks, chunkChars: CHUNK_B64 });
    }
    if (action === 'scan-chunk') {
      const id = clean(b.id, 40), n = Number(b.n);
      const raw = await redis(['HGET', `cg:scans:${project}`, id]);
      if (!raw) return res.status(404).json({ error: 'not_found' });
      const meta = JSON.parse(raw);
      const data = typeof b.data === 'string' ? b.data : '';
      if (!(n >= 0 && n < meta.chunks) || !data || data.length > CHUNK_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: 'bad_chunk' });
      await redis(['SET', `cg:scan:${id}:${n}`, data]);
      return res.status(200).json({ ok: true, n });
    }
    if (action === 'scan-done') {
      const id = clean(b.id, 40);
      const raw = await redis(['HGET', `cg:scans:${project}`, id]);
      if (!raw) return res.status(404).json({ error: 'not_found' });
      const meta = JSON.parse(raw);
      for (let n = 0; n < meta.chunks; n++) if (!Number(await redis(['EXISTS', `cg:scan:${id}:${n}`]))) return res.status(409).json({ error: 'missing_chunk', n });
      meta.ready = true; meta.readyAt = now();
      await redis(['HSET', `cg:scans:${project}`, id, JSON.stringify(meta)]);
      await notify(req, project, { text: `New 3D scan: ${meta.label}`, targets: role === 'gc' ? ['client'] : ['gc'], by: u.name, byAccount: u.identifier });
      return res.status(200).json({ ok: true, scan: meta });
    }
    if (action === 'scan-delete') {
      if (role !== 'gc' && !u.admin) return res.status(403).json({ error: 'gc_only' });
      const id = clean(b.id, 40);
      const raw = await redis(['HGET', `cg:scans:${project}`, id]);
      if (!raw) return res.status(404).json({ error: 'not_found' });
      const meta = JSON.parse(raw);
      for (let n = 0; n < meta.chunks; n++) await redis(['DEL', `cg:scan:${id}:${n}`]);
      await redis(['HDEL', `cg:scans:${project}`, id]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err.message || err).slice(0, 200) });
  }
}
