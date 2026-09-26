// Common Ground — serves each project page only to signed-in members.
//   /anita/client  /anita/gc  /anita/trade   (vercel.json rewrites here)
// Project HTML lives in api/_pages/<project>.html, which is NOT publicly reachable.
import fs from 'node:fs';
import path from 'node:path';
import { storageReady, clean, validProject, ROLES, currentUser, publicUser, roleFor, canView, redis, trackUsage, canonicalRedirect } from './_lib.js';

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

export default async function handler(req, res) {
  const project = clean(req.query.project, 40).toLowerCase();
  const role = clean(req.query.role, 10).toLowerCase();
  const invite = clean(req.query.invite, 80);
  if (!validProject(project)) return send(res, '<h1>Not found</h1>', 404);
  { const qs = new URLSearchParams(); if (invite) qs.set('invite', invite); if (req.query.t) qs.set('t', clean(req.query.t, 80));
    if (canonicalRedirect(req, res, `/${project}${role ? '/' + role : ''}${qs.toString() ? '?' + qs : ''}`)) return; }
  // public GC bid page (token checked by /api/project)
  if (role === 'bid') return send(res, inject(readPage('bid.html'), 'CG_BID', { project, t: clean(req.query.t, 80), storage: storageReady() }));
  if (role && !ROLES.includes(role)) return send(res, '<h1>Not found</h1>', 404);

  const login = (message, extra) => send(res, inject(readPage('login.html'), 'CG_LOGIN',
    Object.assign({ project, role: role || '', invite, message: message || '', storage: storageReady() }, extra || {})));

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
      res.setHeader('Location', `/${project}/${mine}`);
      return res.status(302).end();
    }
    if (!canView(u, project, role)) {
      if (mine) { res.setHeader('Location', `/${project}/${mine}`); return res.status(302).end(); }
      return login('Your account doesn\'t have access to this project.', { adminExists, signedIn: publicUser(u) });
    }

    const session = { user: publicUser(u), project, role, admin: !!u.admin, memberRole: mine };
    return send(res, inject(readPage(`${project}.html`), 'CG_SESSION', session));
  } catch (err) {
    return send(res, '<h1>Something went wrong</h1><p>' + String(err.message || err).replace(/</g, '&lt;').slice(0, 200) + '</p>', 500);
  }
}
