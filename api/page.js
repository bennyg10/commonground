// Common Ground — serves every signed-in page.
//   /dashboard                         → your projects, proposals and tools
//   /141nanita/client|gc|trade         → built-in project pages (anita.html, coolidge.html)
//   /<project>/client|gc|trade         → projects created from the dashboard (workspace.html)
//   /<project>/bid?t=…                 → public GC proposal upload
// Pages live in api/_pages/, which is NOT publicly reachable.
import fs from 'node:fs';
import path from 'node:path';
import {
  storageReady, clean, ROLES, currentUser, publicUser, roleFor, canView, redis, getJSON, trackUsage, canonicalRedirect,
  projectIdFromPath, getProjectMeta, projectPath, listProjects, roleSlug,
} from './_lib.js';

const cache = {};
function readPage(name) {
  if (!cache[name]) cache[name] = fs.readFileSync(path.join(process.cwd(), 'api', '_pages', name), 'utf8');
  return cache[name];
}
const safeJSON = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
function inject(html, varName, data) {
  return html.replace('</head>', `<script>window.${varName}=${safeJSON(data)};</script>\n</head>`);
}
function send(res, html, status = 200) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(status).send(html);
}
const redirect = (res, to) => { res.setHeader('Location', to); return res.status(302).end(); };
const notFound = (res) => send(res, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found — Common Ground</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111015;color:#FDFFFE;font-family:system-ui,sans-serif;padding:24px">
<div style="max-width:380px;text-align:center"><div style="font-size:40px;font-weight:800;color:#D5DC99;margin-bottom:8px">404</div>
<p style="color:rgba(253,255,254,.6);line-height:1.6;margin:0 0 20px">We couldn’t find that project. If you forgot your project’s link, sign in and it’s on your dashboard.</p>
<a href="/dashboard" style="display:inline-block;background:#D5DC99;color:#0B0B0E;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:10px">Go to my dashboard</a></div></body></html>`, 404);

// everything the dashboard shows for one person
async function dashboardData(u) {
  const projects = [];
  const all = u.admin ? await listProjects() : [];
  const ids = new Set(Object.keys(u.projects || {}).concat(all.map((p) => p.id)));
  for (const id of ids) {
    const m = await getProjectMeta(id);
    if (!m) continue;
    const st = (await getJSON(`cg:project:${id}`)) || { stage: 'bidding' };
    projects.push({
      id, path: projectPath(id), name: m.name, address: m.address || '', classification: m.classification || '', scope: m.scope || '',
      role: (u.projects || {})[id] || (u.admin ? 'gc' : ''), member: !!(u.projects || {})[id], builtin: !!m.builtin,
      stage: st.stage || 'bidding', hiredGc: st.hiredGc ? (st.hiredGc.company || st.hiredGc.name) : '', status: m.status || null, createdAt: m.createdAt || '',
    });
  }
  projects.sort((a, b) => (b.member - a.member) || String(b.createdAt).localeCompare(String(a.createdAt)));
  // proposals this person submitted through bid links
  const bids = [];
  for (const [pid, bidId] of Object.entries(u.bids || {})) {
    const m = await getProjectMeta(pid); if (!m) continue;
    const raw = await redis(['HGET', `cg:bids:${pid}`, bidId]); if (!raw) continue;
    let b; try { b = JSON.parse(raw); } catch (e) { continue; }
    const st = (await getJSON(`cg:project:${pid}`)) || {};
    const otherHired = st.hiredGc && st.hiredGc.bidId !== b.id;
    const status = b.status === 'hired' ? 'hired' : (b.status === 'declined' || otherHired) ? 'passed' : 'pending';
    bids.push({ project: pid, path: projectPath(pid), projectName: m.name, address: m.address || '', bidId: b.id, amount: b.amount || null,
                submittedAt: b.submittedAt, status, fileName: b.file ? b.file.name : '', hasFile: !!b.file });
  }
  return { user: publicUser(u), admin: !!u.admin, projects, bids };
}

export default async function handler(req, res) {
  const q = req.query || {};
  const view = clean(q.view, 20);
  const urlRole = clean(q.role, 12).toLowerCase();
  const role = urlRole === 'homeowner' ? 'client' : urlRole;          // /homeowner in the address, 'client' inside
  const invite = clean(q.invite, 80);

  // ── dashboard
  if (view === 'dashboard') {
    if (canonicalRedirect(req, res, '/dashboard')) return;
    if (!storageReady()) return notFound(res);
    await trackUsage();
    const u = await currentUser(req);
    if (!u) return redirect(res, '/?signin=1');
    return send(res, inject(readPage('dashboard.html'), 'CG_DASH', await dashboardData(u)));
  }

  // ── which project? (?project=<id> from fixed rewrites, ?path=<url path> from the catch-all)
  const rawPath = clean(q.path, 70).toLowerCase();
  let project = clean(q.project, 60).toLowerCase();
  if (!project && rawPath) project = await projectIdFromPath(rawPath);
  const meta = project ? await getProjectMeta(project) : null;
  if (!meta) return notFound(res);
  const P = projectPath(project);
  if (role && role !== 'bid' && !ROLES.includes(role)) return notFound(res);
  {
    const qs = new URLSearchParams(); if (invite) qs.set('invite', invite); if (q.t) qs.set('t', clean(q.t, 80));
    const target = `/${P}${role ? '/' + roleSlug(role) : ''}${qs.toString() ? '?' + qs : ''}`;
    if (canonicalRedirect(req, res, target)) return;
    // old addresses (/anita/..., /…/client) → current ones (/141nanita/..., /…/homeowner)
    if ((rawPath && rawPath !== P) || urlRole === 'client') return redirect(res, target);
  }
  const projInfo = { id: project, path: P, name: meta.name, address: meta.address || '', classification: meta.classification || '' };

  // public GC bid page (token checked by /api/project)
  if (role === 'bid') return send(res, inject(readPage('bid.html'), 'CG_BID', { project, path: P, projectName: meta.name, t: clean(q.t, 80), storage: storageReady() }));

  const login = (message, extra) => send(res, inject(readPage('login.html'), 'CG_LOGIN',
    Object.assign({ project, path: P, projectName: meta.title || meta.name, role: role || '', roleUrl: role ? roleSlug(role) : '', invite, message: message || '', storage: storageReady() }, extra || {})));

  if (storageReady()) await trackUsage();
  if (!storageReady()) return login('Sign-in isn\'t connected yet. The database needs to be set up in Vercel.');

  try {
    const adminExists = !!(await redis(['GET', 'cg:admin:exists']));
    if (invite) return login('', { adminExists });
    const u = await currentUser(req);
    if (!u) return login('', { adminExists });

    const mine = roleFor(u, project);
    if (!role) {
      if (!mine) return login('Your account doesn\'t have access to this project.', { adminExists, signedIn: publicUser(u) });
      return redirect(res, `/${P}/${roleSlug(mine)}`);
    }
    if (!canView(u, project, role)) {
      if (mine) return redirect(res, `/${P}/${roleSlug(mine)}`);
      return login('Your account doesn\'t have access to this project.', { adminExists, signedIn: publicUser(u) });
    }

    // the built-in demo pages have homeowner / GC / trade views only; a designer there gets the trade-level view (no pricing)
    const pageRole = meta.builtin && role === 'designer' ? 'trade' : role;
    const session = { user: publicUser(u), project, path: P, projectInfo: projInfo, role: pageRole, roleSlug: roleSlug(role), admin: !!u.admin, memberRole: mine, designer: role === 'designer' };
    return send(res, inject(readPage(meta.builtin ? meta.page : 'workspace.html'), 'CG_SESSION', session));
  } catch (err) {
    return send(res, '<h1>Something went wrong</h1><p>' + String(err.message || err).replace(/</g, '&lt;').slice(0, 200) + '</p>', 500);
  }
}
