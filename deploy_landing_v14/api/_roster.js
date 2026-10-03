// Common Ground — Team & Trades roster: who's on the project, who's been sent a link, who's hired,
// and the work each Trade has completed (with contracts + payment receipts kept on file).
import { redis, getJSON, setJSON, clean, token, rateLimited, notify, createInvite, addMember, projectMembers,
  normalizeIdentifier, sendEmail, emailLayout, escHtml, emailReady, siteOrigin, projectPath, roleSlug, projectTitle } from './_lib.js';

const KEY = (p) => `cg:roster:${p}`;
const now = () => new Date().toISOString();
const money = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) / 100 : null; };
const KINDS = ['trade', 'designer', 'client', 'gc', 'party'];
const DOC_KINDS = ['contract', 'receipt', 'other'];
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_FILE_B64 = 4200000;   // ~3 MB per file (Vercel request limit is 4.5 MB)
const MAX_DOCS = 40, MAX_ENTRIES = 120;
const INVITE_DAYS = 14;

async function load(project) { return (await getJSON(KEY(project))) || { entries: {} }; }
async function save(project, r) { await setJSON(KEY(project), r); }
const validId = (id) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);

// a row the page already shows (seeded list or a project member) gets a stored entry the first time someone acts on it
function upsert(r, id, base) {
  base = base || {};
  let e = r.entries[id];
  if (!e) {
    if (Object.keys(r.entries).length >= MAX_ENTRIES) return null;
    e = r.entries[id] = { id, createdAt: now(), docs: [] };
  }
  if (!e.name || base.name) e.name = clean(base.name, 80) || e.name || 'Team member';
  if (base.specialty) e.specialty = clean(base.specialty, 80);
  if (base.tag) e.tag = clean(base.tag, 30);
  if (KINDS.includes(base.kind)) e.kind = base.kind;
  if (!e.identifier && base.identifier) e.identifier = normalizeIdentifier(base.identifier) || '';
  e.docs = e.docs || [];
  return e;
}

// what a Trade (or anyone who doesn't run the project) sees: names and status only — no amounts, no documents
function publicEntry(e, manager) {
  if (manager) return e;
  return { id: e.id, linked: !!e.identifier, name: e.name, specialty: e.specialty, tag: e.tag, kind: e.kind, rating: e.rating || 0,
    hired: e.hire ? { at: e.hire.at, area: e.hire.area } : null, completed: e.completed ? { at: e.completed.at, area: e.completed.area, date: e.completed.date } : null, custom: !!e.custom };
}

export async function rosterState(project, manager) {
  const r = await load(project);
  const out = { ok: true, entries: Object.values(r.entries).map((e) => publicEntry(e, manager)) };
  if (manager) out.members = (await projectMembers(project)).map((m) => ({ identifier: m.identifier, name: m.name, role: m.role, status: m.status, trade: m.trade || '' }));
  return out;
}

export async function rosterAction(req, project, u, role, manager, action, b) {
  if (!manager) return [403, { error: 'forbidden' }];
  if (await rateLimited(`cg:rl:roster:${u.identifier}`, 300, 3600)) return [429, { error: 'too_many' }];
  const r = await load(project);

  // + Add a Trade / Designer that isn't on the list yet
  if (action === 'roster-add') {
    const name = clean(b.name, 80), specialty = clean(b.specialty, 80);
    if (!name) return [400, { error: 'name_required' }];
    const kind = b.kind === 'designer' ? 'designer' : 'trade';
    const id = 'c-' + token(5).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) + Date.now().toString(36).slice(-4);
    const e = upsert(r, id, { name, specialty: specialty || (kind === 'designer' ? 'Designer' : 'Specialty Trade'), tag: kind === 'designer' ? 'Designer' : (specialty.split(/\s+/)[0] || 'Trade'), kind });
    if (!e) return [409, { error: 'too_many' }];
    e.custom = true; e.contact = clean(b.contact, 120); e.addedBy = u.name;
    await save(project, r);
    return [200, { ok: true, entry: e }];
  }

  const id = clean(b.id, 48).toLowerCase();
  if (!validId(id)) return [400, { error: 'bad_id' }];
  const e = upsert(r, id, b.base);
  if (!e) return [409, { error: 'too_many' }];

  // Send Link: invite them to the project (and email the link when we can)
  if (action === 'roster-link') {
    const identifier = normalizeIdentifier(b.identifier);
    if (!identifier) return [400, { error: 'bad_identifier' }];
    const name = clean(b.name, 80);
    if (!name) return [400, { error: 'name_required' }];
    const asRole = ['trade', 'designer', 'client'].includes(b.role) ? b.role : 'trade';
    const t = await createInvite(project, asRole, name, identifier, u.identifier, INVITE_DAYS);
    const prev = (await projectMembers(project)).find((m) => m.identifier === identifier);
    const entry = { name, role: asRole, status: prev && prev.status === 'active' ? 'active' : 'invited', invitedAt: now() };
    if (asRole === 'trade') entry.trade = clean(b.specialty, 60) || e.specialty || '';
    await addMember(project, identifier, entry);
    e.name = name; e.identifier = identifier; e.kind = asRole; e.linkedAt = now(); e.linkedBy = u.name;
    if (b.specialty) e.specialty = clean(b.specialty, 80);
    await save(project, r);
    const link = `${siteOrigin(req)}/${projectPath(project)}/${roleSlug(asRole)}?invite=${t}`;
    let emailed = false;
    if (identifier.includes('@') && emailReady()) {
      const first = name.split(' ')[0];
      const what = asRole === 'client' ? 'your project' : asRole === 'designer' ? 'the design team' : `the team as ${e.specialty || 'a Specialty Trade'}`;
      emailed = !!(await sendEmail({
        to: identifier,
        subject: `${u.name} added you to ${projectTitle(project)} on Common Ground`,
        html: emailLayout(projectTitle(project), `<p style="margin:0 0 12px">Hi ${escHtml(first)}, ${escHtml(u.name)} added you to ${escHtml(what)} for <b>${escHtml(projectTitle(project))}</b>.</p><p style="margin:0">Tap below to set your password. The link works for ${INVITE_DAYS} days.</p>`,
          { label: 'Open the project', url: link }),
        text: `Hi ${first}, ${u.name} added you to ${projectTitle(project)} on Common Ground. Set your password here (good for ${INVITE_DAYS} days): ${link}`,
      }).then(() => true).catch(() => false));
    }
    return [200, { ok: true, entry: e, link, emailed, expiresInDays: INVITE_DAYS }];
  }

  // Hire someone who's already linked to the project
  if (action === 'roster-hire') {
    if (!['trade', 'designer'].includes(e.kind)) return [400, { error: 'not_hireable' }];
    const m = e.identifier && (await projectMembers(project)).find((x) => x.identifier === e.identifier);
    if (!m) return [409, { error: 'not_linked' }];
    if (m.status !== 'active') return [409, { error: 'not_joined' }];
    const area = clean(b.area, 120);
    if (!area) return [400, { error: 'area_required' }];
    e.hire = { at: now(), by: u.name, area, amount: money(b.amount), start: clean(b.start, 20), note: clean(b.note, 500) };
    await save(project, r);
    await notify(req, project, { text: `${u.name} hired ${e.name}${e.specialty ? ' (' + e.specialty + ')' : ''} for ${area}`, targets: ['client', 'gc'], by: u.name, byAccount: u.identifier, noEmail: true });
    if (e.identifier.includes('@') && emailReady()) {
      await sendEmail({
        to: e.identifier,
        subject: `You're hired — ${projectTitle(project)}`,
        html: emailLayout(projectTitle(project), `<p style="margin:0 0 12px">Congratulations, ${escHtml(e.name.split(' ')[0])}. ${escHtml(u.name)} hired you for <b>${escHtml(area)}</b> on ${escHtml(projectTitle(project))}.</p>${e.hire.start ? `<p style="margin:0 0 12px">Planned start: ${escHtml(e.hire.start)}</p>` : ''}<p style="margin:0">Your scope, schedule and documents live on the project page.</p>`,
          { label: 'Open the project', url: `${siteOrigin(req)}/${projectPath(project)}/${roleSlug(m.role)}` }),
        text: `${u.name} hired you for ${area} on ${projectTitle(project)}. Open the project: ${siteOrigin(req)}/${projectPath(project)}/${roleSlug(m.role)}`,
      }).catch(() => {});
    }
    return [200, { ok: true, entry: e }];
  }

  if (action === 'roster-unhire') {
    if (!e.hire) return [409, { error: 'not_hired' }];
    e.hire = null; await save(project, r);
    return [200, { ok: true, entry: e }];
  }

  // Work Completed: works for Trades hired on the platform and ones who did the work before it
  if (action === 'roster-complete') {
    const area = clean(b.area, 120);
    if (!area) return [400, { error: 'area_required' }];
    e.completed = { at: (e.completed && e.completed.at) || now(), updatedAt: now(), by: u.name, area, date: clean(b.date, 20), amountPaid: money(b.amountPaid), note: clean(b.note, 600) };
    await save(project, r);
    if (!b.quiet) await notify(req, project, { text: `${e.name} marked work completed: ${area}`, targets: ['client', 'gc'], by: u.name, byAccount: u.identifier, noEmail: true });
    return [200, { ok: true, entry: e }];
  }
  if (action === 'roster-reopen') {
    e.completed = null; await save(project, r);
    return [200, { ok: true, entry: e }];
  }

  if (action === 'roster-rate') {
    const n = Math.round(Number(b.rating));
    if (!(n >= 0 && n <= 5)) return [400, { error: 'bad_rating' }];
    e.rating = n; await save(project, r);
    return [200, { ok: true, entry: e }];
  }

  // contracts + payment receipts
  if (action === 'roster-doc') {
    const kind = DOC_KINDS.includes(b.kind) ? b.kind : 'other';
    const type = clean(b.type, 40).toLowerCase(), data = typeof b.data === 'string' ? b.data : '';
    if (!FILE_TYPES.includes(type)) return [400, { error: 'bad_file_type' }];
    if (!data || data.length > MAX_FILE_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return [413, { error: 'file_too_large' }];
    if (e.docs.length >= MAX_DOCS) return [409, { error: 'too_many_docs' }];
    const docId = 'rd' + Date.now().toString(36) + token(3).toLowerCase().replace(/[^a-z0-9]/g, '');
    await redis(['SET', `cg:file:${docId}`, data]);
    const doc = { id: docId, kind, fileName: clean(b.name, 160) || kind, fileType: type, size: Math.round(data.length * 0.75), amount: money(b.amount), by: u.name, at: now() };
    e.docs.push(doc); await save(project, r);
    return [200, { ok: true, entry: e, doc }];
  }
  if (action === 'roster-doc-delete') {
    const docId = clean(b.docId, 40);
    const d = e.docs.find((x) => x.id === docId);
    if (!d) return [404, { error: 'not_found' }];
    await redis(['DEL', `cg:file:${docId}`]);
    e.docs = e.docs.filter((x) => x.id !== docId); await save(project, r);
    return [200, { ok: true, entry: e }];
  }
  return [400, { error: 'bad_action' }];
}

export async function rosterDocFile(project, docId) {
  const r = await load(project);
  for (const e of Object.values(r.entries)) {
    const d = (e.docs || []).find((x) => x.id === docId);
    if (d) { const data = await redis(['GET', `cg:file:${d.id}`]); return data ? { doc: d, data } : null; }
  }
  return null;
}
