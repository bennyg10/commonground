// Common Ground — project lifecycle: GC bidding → hire → kickoff checklist → start.
//   stage: 'bidding' (collecting proposals) → 'kickoff' (GC hired, checklist) → 'active' (project started)
import fs from 'node:fs';
import path from 'node:path';
import {
  storageReady, redis, getJSON, setJSON, clean, validProject, normalizeIdentifier, hashPassword, verifyPassword,
  passwordProblem, token, createSession, currentUser, roleFor, rateLimited, ip, trackUsage, notify,
  sendEmail, emailLayout, escHtml, siteOrigin, projectTitle, createInvite, addMember, projectMembers, SUPPORT_EMAIL,
  indexUser, projectPath, getProjectMeta, RESERVED_PATHS, BUILTIN, ROLES,
} from './_lib.js';
import { createSubRequest, listSubRequests, publicSubRequest, cancelSubRequest, markSubInvited } from './_subs.js';

export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

const MAX_FILE_BYTES = 3 * 1024 * 1024;                 // 3 MB — bigger files need Vercel Blob
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'];
const now = () => new Date().toISOString();
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// ── kickoff template: luxury-level construction management kickoff ──
function kickoffTemplate(gcName) {
  const t = (id, group, text, detail, owner, type, extra) => Object.assign(
    { id, group, text, detail, owner, type: type || 'task', required: true, done: false, tags: [], gcAgreed: false, clientAgreed: false, addedBy: 'template', at: now() }, extra || {});
  return [
    t('k-contract', 'Contract + agreements', 'Construction contract signed — scope, price, exclusions', 'Both sign the Phase 1 contract in Common Ground before any work or deposits.', 'both', 'agreement'),
    t('k-draws', 'Contract + agreements', 'Draw schedule + retention agreed', 'Deposit, progress draws tied to milestones, final payment at completion.', 'both', 'agreement'),
    t('k-co', 'Contract + agreements', 'Change-order rule: written, priced, approved before work', 'No verbal changes. Every CO is priced and approved by the owner in Common Ground first.', 'both', 'agreement'),
    t('k-unpermitted', 'Contract + agreements', 'Unpermitted work identified — agree how it’s handled', 'Document any existing unpermitted work now. Tag it Permits Later if it is legalized or permitted in a later phase, so it doesn’t block demo.', 'both', 'agreement', { agreeTag: 'Permits Later' }),
    t('k-allow', 'Contract + agreements', 'Allowances + exclusions walked through with owner', 'Hazmat abatement, contaminated soil, concealed utilities, extra soil haul ($1,500/load).', 'both', 'agreement'),
    t('k-comms', 'Contract + agreements', 'Communication cadence set', 'Weekly owner meeting, daily log in Common Ground, 48-hour decision turnaround.', 'both', 'agreement'),
    t('k-license', 'Compliance + insurance', 'CSLB license verified + on file', 'Active license, correct classification for demolition / grading.', 'gc'),
    t('k-insurance', 'Compliance + insurance', 'Insurance certificates on file — owner named additional insured', 'General liability + workers’ comp for GC and every sub on site.', 'gc'),
    t('k-liens', 'Compliance + insurance', 'Lien release process set', 'Conditional release with each draw request, unconditional after payment clears.', 'gc'),
    t('k-survey', 'Pre-construction', 'Survey ordered', 'Feeds the demolition / site plan for LADBS.', 'gc'),
    t('k-testing', 'Pre-construction', 'Environmental testing ordered (asbestos / lead)', 'Required before demo; results gate the permit. Abatement is a change order if found.', 'gc'),
    t('k-permit', 'Pre-construction', 'LADBS demolition permit plan + target filing date', 'Check ZIMAS for historic review first (built 1925).', 'gc'),
    t('k-utilities', 'Pre-construction', 'Utility disconnect requests submitted', 'Electric, gas, water disposition, sewer cap, telecom. DigAlert 811 before digging.', 'gc'),
    t('k-neighbor', 'Pre-construction', 'Neighbor notice + pre-demo condition photos (135 N Anita)', 'Schedule, CMU wall plan, photos of shared wall, sidewalk, curb and street.', 'gc'),
    t('k-protect', 'Pre-construction', 'Site protection plan in place', 'Fencing, dust + erosion control, street and sidewalk protection.', 'gc'),
    t('k-schedule', 'Pre-construction', 'Baseline schedule shared', 'Pre-con 4–8+ weeks, demo 2–4 weeks; update when permit and utility dates are known.', 'gc'),
    t('k-subs', 'Pre-construction', 'Sub list + insurance for demo, grading, hauling', 'Names, license numbers and COIs for each sub before they step on site.', 'gc'),
    t('k-rules', 'Pre-construction', 'Jobsite rules + safety plan', 'Work hours, parking, toilet, deliveries, daily cleanup.', 'gc'),
    t('k-owner-contact', 'Owner', 'Owner confirms point of contact + preferred channel', 'Who approves, how to reach them (text or email), and backup contact.', 'client'),
  ];
}
// kickoff for projects created on the platform (not tied to one city or scope)
function genericKickoff(meta) {
  const t = (id, group, text, detail, owner, type, extra) => Object.assign(
    { id, group, text, detail, owner, type: type || 'task', required: true, done: false, tags: [], gcAgreed: false, clientAgreed: false, addedBy: 'template', at: now() }, extra || {});
  const commercial = meta && meta.classification === 'commercial';
  return [
    t('k-contract', 'Contract + agreements', 'Construction contract signed — scope, price, exclusions', 'Both sign the contract in Common Ground before any work or deposits.', 'both', 'agreement'),
    t('k-draws', 'Contract + agreements', 'Payment schedule agreed', 'Deposit, progress payments tied to milestones, final payment at completion.', 'both', 'agreement'),
    t('k-co', 'Contract + agreements', 'Change-order rule: written, priced, approved before work', 'No verbal changes. Every change order is priced and approved in Common Ground first.', 'both', 'agreement'),
    t('k-unpermitted', 'Contract + agreements', 'Existing unpermitted work identified — agree how it’s handled', 'Document it now. Tag it Permits Later if it is legalized in a later phase.', 'both', 'agreement', { agreeTag: 'Permits Later' }),
    t('k-comms', 'Contract + agreements', 'Communication cadence set', 'Weekly check-in, progress updates in Common Ground, 48-hour decision turnaround.', 'both', 'agreement'),
    t('k-license', 'Compliance + insurance', 'Contractor license verified + on file', 'Active license with the right classification for this scope.', 'gc'),
    t('k-insurance', 'Compliance + insurance', 'Insurance certificates on file — owner named additional insured', 'General liability + workers’ comp for the GC and every sub on site.', 'gc'),
    t('k-liens', 'Compliance + insurance', 'Lien release process set', 'Conditional release with each payment request, unconditional after payment clears.', 'gc'),
    t('k-codecheck', 'Pre-construction', commercial ? 'Code check run on plans (building, accessibility, fire)' : 'Code check run on plans', 'Use the Code check tool before submitting for permit.', 'gc'),
    t('k-permit', 'Pre-construction', 'Permit plan + target filing date', 'Which permits, who pulls them, and when.', 'gc'),
    t('k-schedule', 'Pre-construction', 'Baseline schedule shared', 'Phases and milestones; update as permit and inspection dates firm up.', 'gc'),
    t('k-subs', 'Pre-construction', 'Sub list + insurance on file', 'Names, license numbers and certificates for each sub before they start.', 'gc'),
    t('k-rules', 'Pre-construction', 'Jobsite rules + safety plan', 'Work hours, parking, deliveries, daily cleanup, site protection.', 'gc'),
    t('k-owner-contact', 'Owner', 'Owner confirms point of contact + preferred channel', 'Who approves, how to reach them, and a backup contact.', 'client'),
  ];
}
const agreementDone = (i) => i.type === 'agreement' ? (i.gcAgreed && i.clientAgreed) : i.done;
const blockers = (items) => items.filter((i) => i.required && !agreementDone(i));

// ── one-time seed: proposal already received (Trujillo, 9/18/26) ──
export async function seedProject(project) {
  if (await redis(['GET', `cg:seeded:${project}`])) return;
  const seedPath = path.join(process.cwd(), 'api', '_pages', `${project}-seed.json`);
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (seed.project && !(await getJSON(`cg:project:${project}`))) await setJSON(`cg:project:${project}`, seed.project);
    for (const b of seed.bids || []) {
      let file = null;
      if (b.file && b.file.path) {
        const data = fs.readFileSync(path.join(process.cwd(), 'api', '_pages', b.file.path)).toString('base64');
        const fileId = 'f-' + b.id;
        await redis(['SET', `cg:file:${fileId}`, data]);
        file = { id: fileId, name: b.file.name, type: b.file.type, size: Math.round(data.length * 0.75) };
      }
      const bid = Object.assign({ status: 'submitted', submittedAt: b.date || now(), source: 'uploaded by owner' }, b, { file });
      await redis(['HSET', `cg:bids:${project}`, b.id, JSON.stringify(bid)]);
    }
  }
  await redis(['SET', `cg:seeded:${project}`, '1']);
}
async function getProject(project) {
  return (await getJSON(`cg:project:${project}`)) || { stage: 'bidding', hiredGc: null, startedAt: null };
}
async function listBids(project) {
  const flat = (await redis(['HGETALL', `cg:bids:${project}`])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
}
async function clientName(project) {
  const m = (await projectMembers(project)).find((x) => x.role === 'client' && x.status === 'active');
  return m ? m.name : 'the homeowner';
}
const publicBid = (b) => Object.assign({}, b, { account: undefined });

// ── new projects from the dashboard ──
export const PHASES = ['Pre-construction', 'Design + plans', 'Permitting', 'Demolition', 'Site work + grading', 'Foundation', 'Framing',
  'Rough-ins (MEP)', 'Inspections', 'Insulation + drywall', 'Finishes', 'Punch list', 'Closeout'];
const SCOPES = ['new-build', 'remodel', 'addition', 'adu', 'demolition', 'tenant-improvement', 'repair'];
const SUBTYPES = { residential: ['single-family', 'multi-family', 'adu', 'condo-townhome'], commercial: ['office', 'retail', 'restaurant', 'mixed-use', 'industrial', 'other'] };
export function slugFromAddress(addr) {
  const first = String(addr || '').split(',')[0].toLowerCase();
  return first.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 40);
}
function cleanStatus(b, prev) {
  const pct = Number(b.percent);
  const phase = clean(b.phase, 60);
  return Object.assign({}, prev || {}, {
    phase: phase || (prev && prev.phase) || 'Pre-construction',
    percent: isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : ((prev && prev.percent) || 0),
    nextMilestone: b.nextMilestone !== undefined ? clean(b.nextMilestone, 120) : ((prev && prev.nextMilestone) || ''),
    startDate: b.startDate !== undefined ? clean(b.startDate, 20) : ((prev && prev.startDate) || ''),
    note: b.note !== undefined ? clean(b.note, 300) : ((prev && prev.note) || ''),
    updatedAt: now(),
  });
}
async function createProject(req, res, b) {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'sign_in_required' });
  if (!u.admin && await rateLimited(`cg:rl:create:${u.identifier}`, 25, 86400)) return res.status(429).json({ error: 'too_many_attempts' });
  const address = clean(b.address, 160);
  if (address.length < 5) return res.status(400).json({ error: 'address_required' });
  const classification = clean(b.classification, 20);
  if (!['residential', 'commercial'].includes(classification)) return res.status(400).json({ error: 'classification_required' });
  const subtype = (SUBTYPES[classification] || []).includes(clean(b.subtype, 30)) ? clean(b.subtype, 30) : '';
  const scope = SCOPES.includes(clean(b.scope, 30)) ? clean(b.scope, 30) : '';
  const as = clean(b.as, 10) || (u.accountType === 'contractor' ? 'gc' : u.accountType === 'homeowner' ? 'client' : u.accountType === 'designer' ? 'designer' : '');
  if (!['client', 'gc', 'designer'].includes(as)) return res.status(400).json({ error: 'account_type_required' });
  const mode = as === 'gc' && clean(b.mode, 10) === 'underway' ? 'underway' : 'new';
  // unique, readable URL: "123 Main St, …" → /123mainst
  let base = slugFromAddress(address);
  if (base.length < 3) base = 'project' + base;
  if (/^[0-9]+$/.test(base)) base += 'project';
  const taken = new Set(RESERVED_PATHS.concat(Object.values(BUILTIN).flatMap((x) => [x.id, x.path])));
  const meta = { name: clean(b.name, 80) || address.split(',')[0].trim(), address, classification, subtype, scope, mode,
    createdBy: u.identifier, createdByName: u.name, creatorRole: as, createdAt: now() };
  if (as === 'gc') meta.status = cleanStatus(mode === 'underway' ? b : { phase: 'Pre-construction', percent: 0 }, null);
  let id = null;
  for (let i = 1; i <= 60 && !id; i++) {
    const cand = i === 1 ? base : `${base}-${i}`;
    if (taken.has(cand)) continue;
    const ok = await redis(['SET', `cg:proj:${cand}`, JSON.stringify(Object.assign({ id: cand, path: cand }, meta)), 'NX']);
    if (ok) id = cand;
  }
  if (!id) return res.status(409).json({ error: 'address_taken' });
  await redis(['SADD', 'cg:projects', id]);
  const hiredGc = as === 'gc' ? { name: u.name, company: u.company || u.name, identifier: u.identifier, phone: u.phone || '', bidId: null, amount: null, hiredAt: now(), hiredBy: 'self' } : null;
  await setJSON(`cg:project:${id}`, { stage: as === 'gc' ? 'active' : 'bidding', hiredGc, startedAt: as === 'gc' ? now() : null, startedBy: as === 'gc' ? u.name : undefined });
  await redis(['SET', `cg:seeded:${id}`, '1']);
  u.projects = Object.assign({}, u.projects, { [id]: as });
  if (!u.accountType) u.accountType = as === 'gc' ? 'contractor' : as === 'designer' ? 'designer' : 'homeowner';
  await setJSON(`cg:user:${u.identifier}`, u);
  await addMember(id, u.identifier, { name: u.name, role: as, status: 'active', joinedAt: now() });
  // a GC or designer can bring their client in right away
  let clientInvite = null;
  const cEmail = normalizeIdentifier(b.clientEmail || ''), cName = clean(b.clientName, 80);
  if ((as === 'gc' || as === 'designer') && cEmail && cName) {
    const t = await createInvite(id, 'client', cName, cEmail, u.identifier, 14);
    await addMember(id, cEmail, { name: cName, role: 'client', status: 'invited', invitedAt: now() });
    clientInvite = { name: cName, identifier: cEmail, link: `${siteOrigin(req)}/${id}/homeowner?invite=${t}` };
    if (cEmail.includes('@')) {
      const sent = await sendEmail({ to: cEmail, subject: `${u.name} set up ${meta.name} on Common Ground`,
        html: emailLayout('Your project', `<h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;color:#FDFFFE">Hi ${escHtml(firstName(cName))},</h1>
          <p style="margin:0">${escHtml(u.name)} set up <b>${escHtml(meta.name)}</b> on Common Ground so you can follow progress, approve decisions and see every document in one place.</p>`,
          { label: 'Open your project', url: clientInvite.link }),
        text: `${u.name} set up ${meta.name} on Common Ground. Open your project: ${clientInvite.link}` });
      clientInvite.emailed = !!sent.ok;
    }
  }
  return res.status(200).json({ ok: true, project: Object.assign({ id, path: id }, meta), url: `/${id}/${as === 'client' ? 'homeowner' : as}`, clientInvite });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storageReady()) return res.status(503).json({ error: 'storage_not_configured' });
  await trackUsage();
  const q = req.query || {};
  const b = req.method === 'POST' ? (req.body || {}) : {};
  const project = clean((req.method === 'GET' ? q.project : b.project) || '', 60).toLowerCase();
  const action = clean(req.method === 'GET' ? q.action : b.action, 30);
  if (req.method === 'POST' && action === 'create') return createProject(req, res, b);
  if (!(await validProject(project))) return res.status(400).json({ error: 'bad_project' });

  try {
    await seedProject(project);

    // ════════ PUBLIC: bid page (token-based) ════════
    if (req.method === 'GET' && action === 'bidinfo') {
      const inv = await getJSON(`cg:bidinvite:${clean(q.t, 80)}`);
      if (!inv || inv.project !== project) return res.status(404).json({ error: 'bid_link_invalid' });
      const p = await getProject(project);
      return res.status(200).json({ ok: true, project: projectTitle(project), clientName: inv.byName || (await clientName(project)),
        stage: p.stage, invitee: inv.open ? null : { name: inv.name, email: inv.email, phone: inv.phone } });
    }

    if (req.method === 'POST' && action === 'bid-submit') {
      if (await rateLimited(`cg:rl:bid:${ip(req)}`, 12, 3600)) return res.status(429).json({ error: 'too_many_attempts' });
      const inv = await getJSON(`cg:bidinvite:${clean(b.t, 80)}`);
      if (!inv || inv.project !== project) return res.status(404).json({ error: 'bid_link_invalid' });
      const p = await getProject(project);
      if (p.stage !== 'bidding') return res.status(409).json({ error: 'bidding_closed' });
      const name = clean(b.name, 80), company = clean(b.company, 100), phone = clean(b.phone, 30);
      const identifier = normalizeIdentifier(b.email);
      if (!name) return res.status(400).json({ error: 'name_required' });
      if (!identifier || !identifier.includes('@')) return res.status(400).json({ error: 'bad_email' });
      const f = b.file || {};
      const type = clean(f.type, 60), data = typeof f.data === 'string' ? f.data : '';
      if (!data) return res.status(400).json({ error: 'file_required' });
      if (!FILE_TYPES.includes(type)) return res.status(400).json({ error: 'bad_file_type' });
      if (data.length * 0.75 > MAX_FILE_BYTES) return res.status(413).json({ error: 'file_too_large' });

      let user = await getJSON(`cg:user:${identifier}`);
      if (user) {
        if (!verifyPassword(String(b.password || ''), user.hash)) return res.status(401).json({ error: 'account_exists' });
      } else {
        const pp = passwordProblem(b.password); if (pp) return res.status(400).json({ error: 'weak_password', message: pp });
        user = { name, identifier, phone, hash: hashPassword(b.password), admin: false, projects: {}, accountType: 'contractor', company, createdAt: now(), source: 'bid' };
      }
      const existing = (await listBids(project)).find((x) => x.account === identifier);
      const bidId = existing ? existing.id : 'bid-' + Date.now().toString(36);
      const fileId = 'f-' + bidId + '-' + Date.now().toString(36);
      await redis(['SET', `cg:file:${fileId}`, data]);
      if (existing && existing.file) await redis(['DEL', `cg:file:${existing.file.id}`]);
      const amount = Number(b.amount);
      const bid = { id: bidId, gcName: company || name, contactName: name, company, email: identifier, phone, account: identifier,
        amount: isFinite(amount) && amount > 0 ? Math.round(amount) : null, note: clean(b.note, 600), status: 'submitted',
        submittedAt: now(), source: inv.open ? 'open link' : 'invited', file: { id: fileId, name: clean(f.name, 120) || 'proposal', type, size: Math.round(data.length * 0.75) } };
      user.bids = Object.assign({}, user.bids, { [project]: bidId });
      if (phone && !user.phone) user.phone = phone;
      await setJSON(`cg:user:${identifier}`, user);
      await indexUser(identifier);
      await redis(['HSET', `cg:bids:${project}`, bidId, JSON.stringify(bid)]);
      if (!inv.open) await redis(['HSET', `cg:bidinvites:${project}`, inv.email || identifier, JSON.stringify(Object.assign({}, inv, { status: 'submitted', bidId }))]);
      await createSession(req, res, identifier);

      const client = inv.byName || (await clientName(project));
      await notify(req, project, { text: `New proposal from ${bid.gcName}${bid.amount ? ' · $' + bid.amount.toLocaleString('en-US') : ''}`, targets: ['client', 'gc'], by: name, byAccount: identifier });
      const help = `${siteOrigin(req)}/help?from=${encodeURIComponent(identifier)}&project=${project}`;
      await sendEmail({
        to: identifier,
        subject: `Proposal submitted to ${client} — ${projectTitle(project)}`,
        html: emailLayout('Proposal received',
          `<h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;color:#FDFFFE">Welcome to Common Ground, ${escHtml(firstName(name))}.</h1>
           <p style="margin:0 0 12px">Your proposal for <b>${escHtml(projectTitle(project))}</b> was submitted to <b>${escHtml(client)}</b>. You’ll hear back here as soon as they decide.</p>
           <p style="margin:0 0 12px">Our goal is simple: give great GCs a faster path from proposal to signed contract to final walkthrough, with every scope, decision and payment documented in one place.</p>
           <p style="margin:0">We’re here to help you close this project with speed and smooth communication.</p>
           <div style="height:28px"></div>`,
          null,
          `<b style="color:#FDFFFE">Contact the platform</b><br>Questions about your account or how to use Common Ground? We’re here to help.
           <table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:12px"><tr><td style="border:1px solid #D5DC99;border-radius:9px"><a href="${escHtml(help)}" style="display:inline-block;padding:11px 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;color:#D5DC99;text-decoration:none">Contact the platform</a></td></tr></table>`),
        text: `Welcome to Common Ground, ${firstName(name)}.\n\nYour proposal for ${projectTitle(project)} was submitted to ${client}.\n\nOur goal is simple: give great GCs a faster path from proposal to signed contract to final walkthrough, with every scope, decision and payment documented in one place.\n\nWe're here to help you close this project with speed and smooth communication.\n\n\nContact the platform (account help or how to use it): ${help}`,
      });
      return res.status(200).json({ ok: true, bidId, clientName: client, helpUrl: help });
    }

    // ════════ SIGNED-IN ════════
    const u = await currentUser(req);
    // a GC who bid (not a member) can always open their own proposal
    if (req.method === 'GET' && action === 'file' && u && !roleFor(u, project)) {
      const bid = (await listBids(project)).find((x) => x.id === clean(q.bid, 60));
      if (!bid || !bid.file || bid.account !== u.identifier) return res.status(403).json({ error: 'forbidden' });
      const data = await redis(['GET', `cg:file:${bid.file.id}`]);
      if (!data) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Content-Type', bid.file.type);
      res.setHeader('Content-Disposition', `inline; filename="${bid.file.name.replace(/[^\w.\- ]/g, '')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).send(Buffer.from(data, 'base64'));
    }
    const role = roleFor(u, project);
    if (!u || !role) return res.status(401).json({ error: 'sign_in_required' });
    const isOwner = (u.projects || {})[project] === 'client' || !!u.admin;
    const isGC = role === 'gc';                           // hired GC, or admin
    const p = await getProject(project);

    // ════════ SUB RECOMMENDATIONS (homeowner / GC) ════════
    if (action === 'sub-requests' || action === 'sub-request' || action === 'sub-cancel' || action === 'sub-invited') {
      if (role === 'trade') return res.status(403).json({ error: 'forbidden' });
      if (req.method === 'GET') return res.status(200).json({ ok: true, requests: (await listSubRequests(project)).filter((r) => r.status !== 'cancelled').map(publicSubRequest) });
      if (action === 'sub-request') { const out = await createSubRequest(req, project, u, role, b); return res.status(out.status).json(out.body); }
      if (action === 'sub-cancel') { const out = await cancelSubRequest(project, u, role, clean(b.id, 20)); return res.status(out.status).json(out.body); }
      await markSubInvited(project, clean(b.id, 20), clean(b.option, 20), clean(b.identifier, 120));
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && action === 'state') {
      const owners = (await projectMembers(project)).filter((m) => m.role === 'client' && m.status === 'active').map((m) => m.name);
      const meta = await getProjectMeta(project);
      const out = { ok: true, stage: p.stage, hiredGc: p.hiredGc, startedAt: p.startedAt, clientName: await clientName(project), clientNames: owners,
        meta: { name: meta.name, address: meta.address || '', classification: meta.classification || '', subtype: meta.subtype || '', scope: meta.scope || '',
                mode: meta.mode || '', status: meta.status || null, path: projectPath(project), builtin: !!meta.builtin }, phases: PHASES };
      if (isOwner) {
        out.bids = (await listBids(project)).map(publicBid);
        const flat = (await redis(['HGETALL', `cg:bidinvites:${project}`])) || [];
        out.bidInvites = []; for (let i = 0; i < flat.length; i += 2) { try { const x = JSON.parse(flat[i + 1]); delete x.token; out.bidInvites.push(x); } catch (e) {} }
      }
      if (role !== 'trade') out.kickoff = (await getJSON(`cg:kickoff:${project}`)) || { items: [] };
      return res.status(200).json(out);
    }

    if (req.method === 'GET' && action === 'file') {
      const bid = (await listBids(project)).find((x) => x.id === clean(q.bid, 60));
      if (!bid || !bid.file) return res.status(404).json({ error: 'not_found' });
      if (!isOwner && !(p.hiredGc && p.hiredGc.bidId === bid.id && isGC)) return res.status(403).json({ error: 'forbidden' });
      const data = await redis(['GET', `cg:file:${bid.file.id}`]);
      if (!data) return res.status(404).json({ error: 'not_found' });
      res.setHeader('Content-Type', bid.file.type);
      res.setHeader('Content-Disposition', `inline; filename="${bid.file.name.replace(/[^\w.\- ]/g, '')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).send(Buffer.from(data, 'base64'));
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // ── owner: invite a GC to bid / open link
    if (action === 'bid-invite' || action === 'bid-link') {
      if (!isOwner) return res.status(403).json({ error: 'owner_only' });
      if (p.stage !== 'bidding') return res.status(409).json({ error: 'bidding_closed' });
      if (action === 'bid-link') {
        let t = await redis(['GET', `cg:bidlink:${project}`]);
        if (!t) { t = token(18); await setJSON(`cg:bidinvite:${t}`, { project, open: true, by: u.identifier, byName: u.admin ? await clientName(project) : u.name, at: now() }); await redis(['SET', `cg:bidlink:${project}`, t]); }
        return res.status(200).json({ ok: true, link: `${siteOrigin(req)}/${projectPath(project)}/bid?t=${t}` });
      }
      const name = clean(b.name, 80), phone = clean(b.phone, 30);
      const email = normalizeIdentifier(b.email);
      if (!name) return res.status(400).json({ error: 'name_required' });
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'bad_email' });
      const t = token(18);
      const byName = u.admin ? await clientName(project) : u.name;
      await setJSON(`cg:bidinvite:${t}`, { project, name, email, phone, by: u.identifier, byName, at: now() }, 45 * 86400);
      await redis(['HSET', `cg:bidinvites:${project}`, email, JSON.stringify({ name, email, phone, status: 'invited', at: now() })]);
      const link = `${siteOrigin(req)}/${projectPath(project)}/bid?t=${t}`;
      const sent = await sendEmail({
        to: email,
        subject: `${byName} invited you to bid on ${projectTitle(project)}`,
        html: emailLayout('Invitation to bid',
          `<h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;color:#FDFFFE">Hi ${escHtml(firstName(name))}, you’re invited to submit a proposal.</h1>
           <p style="margin:0">${escHtml(byName)} is collecting GC proposals for <b>${escHtml(projectTitle(project))}</b>. Upload yours and create your account in one step.</p>`,
          { label: 'Upload your proposal', url: link }),
        text: `${byName} invited you to submit a proposal for ${projectTitle(project)}.\n\nUpload it here: ${link}`,
      });
      return res.status(200).json({ ok: true, link, emailed: !!sent.ok });
    }

    // ── owner: hire / don't hire
    if (action === 'hire' || action === 'decline') {
      if (!isOwner) return res.status(403).json({ error: 'owner_only' });
      const bids = await listBids(project);
      const bid = bids.find((x) => x.id === clean(b.bidId, 60));
      if (!bid) return res.status(404).json({ error: 'not_found' });
      if (action === 'decline') {
        if (p.hiredGc && p.hiredGc.bidId === bid.id) return res.status(409).json({ error: 'already_hired' });
        bid.status = 'declined'; bid.decidedAt = now(); bid.decidedBy = u.name;
        await redis(['HSET', `cg:bids:${project}`, bid.id, JSON.stringify(bid)]);
        return res.status(200).json({ ok: true, bid: publicBid(bid) });
      }
      if (p.stage !== 'bidding') return res.status(409).json({ error: 'already_hired' });
      // contact: from the GC's account, or supplied by the owner (e.g. a proposal they uploaded themselves)
      let identifier = bid.account || normalizeIdentifier(b.email || bid.email || '');
      if (!identifier || !identifier.includes('@')) return res.status(400).json({ error: 'contact_required' });
      const phone = clean(b.phone, 30) || bid.phone || '';
      const gcName = bid.contactName || bid.gcName;
      let link, accountReady = false;
      const existing = await getJSON(`cg:user:${identifier}`);
      if (existing) {
        existing.projects = Object.assign({}, existing.projects, { [project]: 'gc' });
        await setJSON(`cg:user:${identifier}`, existing);
        await addMember(project, identifier, { name: existing.name, role: 'gc', status: 'active', joinedAt: now() });
        link = `${siteOrigin(req)}/${projectPath(project)}/gc`; accountReady = true;
      } else {
        const t = await createInvite(project, 'gc', gcName, identifier, u.identifier, 30);
        await addMember(project, identifier, { name: gcName, role: 'gc', status: 'invited', invitedAt: now() });
        link = `${siteOrigin(req)}/${projectPath(project)}/gc?invite=${t}`;
      }
      bid.status = 'hired'; bid.decidedAt = now(); bid.decidedBy = u.name; bid.email = identifier; if (phone) bid.phone = phone;
      await redis(['HSET', `cg:bids:${project}`, bid.id, JSON.stringify(bid)]);
      const hiredGc = { name: gcName, company: bid.company || bid.gcName, identifier, phone, bidId: bid.id, amount: bid.amount, hiredAt: now(), hiredBy: u.name };
      await setJSON(`cg:project:${project}`, Object.assign({}, p, { stage: 'kickoff', hiredGc }));
      await setJSON(`cg:kickoff:${project}`, { items: project === 'anita' ? kickoffTemplate(gcName) : genericKickoff(await getProjectMeta(project)), createdAt: now() });
      await notify(req, project, { text: `${hiredGc.company} hired as GC for ${projectTitle(project)}`, targets: ['client', 'gc'], by: u.name, byAccount: u.identifier, noEmail: true });
      const sent = await sendEmail({
        to: identifier,
        subject: `Congratulations — you’ve been hired for ${projectTitle(project)}`,
        html: emailLayout('You’re hired',
          `<h1 style="font-size:22px;line-height:1.3;margin:0 0 12px;color:#FDFFFE">Congratulations, ${escHtml(firstName(gcName))}!</h1>
           <p style="margin:0 0 12px"><b>${escHtml(u.admin ? await clientName(project) : u.name)}</b> hired you as the general contractor for <b>${escHtml(projectTitle(project))}</b>.</p>
           <p style="margin:0">Open the project to review your kickoff checklist. Once it’s complete, tap <b>Start Project</b> and the owner is notified.</p>`,
          { label: 'Open project', url: link }),
        text: `Congratulations, ${firstName(gcName)}! You've been hired for ${projectTitle(project)}.\n\nOpen the project: ${link}`,
      });
      const sms = `Congratulations ${firstName(gcName)} — you've been hired for ${projectTitle(project)} on Common Ground. Open your project: ${link}`;
      return res.status(200).json({ ok: true, link, accountReady, emailed: !!sent.ok, sms, phone, hiredGc });
    }

    // ── kickoff checklist
    if (action === 'kickoff') {
      if (p.stage === 'bidding') return res.status(409).json({ error: 'no_gc_yet' });
      const doc = (await getJSON(`cg:kickoff:${project}`)) || { items: [] };
      const op = clean(b.op, 20);
      const item = doc.items.find((i) => i.id === clean(b.id, 60));
      const actor = isGC ? 'gc' : (u.projects || {})[project] === 'client' ? 'client' : null;
      if (!actor) return res.status(403).json({ error: 'forbidden' });
      let note = null;

      if (op === 'toggle') {
        if (!item) return res.status(404).json({ error: 'not_found' });
        if (item.type === 'agreement') return res.status(400).json({ error: 'use_agree' });
        if (item.owner === 'client' ? actor !== 'client' && actor !== 'gc' : actor !== 'gc') return res.status(403).json({ error: 'forbidden' });
        item.done = !item.done; item.doneBy = u.name; item.doneAt = now();
      } else if (op === 'agree' || op === 'unagree') {
        if (!item || item.type !== 'agreement') return res.status(400).json({ error: 'not_agreement' });
        const v = op === 'agree';
        if (actor === 'gc') { item.gcAgreed = v; item.gcAgreedBy = u.name; } else { item.clientAgreed = v; item.clientAgreedBy = u.name; }
        if (item.agreeTag) item.tags = item.gcAgreed && item.clientAgreed ? Array.from(new Set([...(item.tags || []), item.agreeTag])) : (item.tags || []).filter((t) => t !== item.agreeTag);
        item.done = item.gcAgreed && item.clientAgreed;
        if (v && !item.done) note = { text: `${u.name} agreed: ${item.text} — waiting on ${actor === 'gc' ? 'you' : 'the GC'}`, targets: [actor === 'gc' ? 'client' : 'gc'] };
        if (item.done) note = { text: `Agreed by both: ${item.text}${item.agreeTag ? ' · tagged ' + item.agreeTag : ''}`, targets: ['client', 'gc'] };
      } else if (op === 'confirm') {
        if (!item || actor !== 'client') return res.status(403).json({ error: 'forbidden' });
        item.clientConfirmed = true; item.clientConfirmedAt = now();
        note = { text: `Owner confirmed: ${item.text}`, targets: ['gc'] };
      } else if (op === 'add' || op === 'edit' || op === 'delete' || op === 'tag') {
        if (actor !== 'gc') return res.status(403).json({ error: 'gc_only' });
        if (op === 'add') {
          const text = clean(b.text, 160); if (!text) return res.status(400).json({ error: 'text_required' });
          const type = b.type === 'agreement' ? 'agreement' : 'task';
          const n = { id: 'k-' + Date.now().toString(36), group: clean(b.group, 60) || 'Added by GC', text, detail: clean(b.detail, 300),
            owner: type === 'agreement' ? 'both' : (b.owner === 'client' ? 'client' : 'gc'), type, required: b.required !== false, done: false,
            tags: (Array.isArray(b.tags) ? b.tags : []).map((t) => clean(t, 30)).filter(Boolean).slice(0, 4), gcAgreed: false, clientAgreed: false,
            agreeTag: clean(b.agreeTag, 30), addedBy: u.name, at: now() };
          if (p.stage === 'active') n.needsClientConfirm = true;
          doc.items.push(n);
          note = { text: `${u.name} added to the checklist: ${text}${p.stage === 'active' ? ' — please confirm' : ''}`, targets: ['client'] };
        } else if (!item) {
          return res.status(404).json({ error: 'not_found' });
        } else if (op === 'edit') {
          if (clean(b.text, 160)) item.text = clean(b.text, 160);
          if (typeof b.detail === 'string') item.detail = clean(b.detail, 300);
          if (typeof b.required === 'boolean') item.required = b.required;
          item.editedBy = u.name; item.editedAt = now();
          if (p.stage === 'active') { item.needsClientConfirm = true; item.clientConfirmed = false; note = { text: `${u.name} updated a checklist item: ${item.text} — please confirm`, targets: ['client'] }; }
        } else if (op === 'delete') {
          doc.items = doc.items.filter((i) => i.id !== item.id);
          if (p.stage === 'active') note = { text: `${u.name} removed from the checklist: ${item.text}`, targets: ['client'] };
        } else if (op === 'tag') {
          const tag = clean(b.tag, 30); if (!tag) return res.status(400).json({ error: 'tag_required' });
          item.tags = (item.tags || []).includes(tag) ? item.tags.filter((t) => t !== tag) : [...(item.tags || []), tag].slice(0, 5);
        }
      } else {
        return res.status(400).json({ error: 'bad_op' });
      }
      doc.updatedAt = now();
      await setJSON(`cg:kickoff:${project}`, doc);
      if (note) await notify(req, project, Object.assign(note, { by: u.name, byAccount: u.identifier }));
      return res.status(200).json({ ok: true, kickoff: doc });
    }

    // ── owner (final say): release the GC and go back to bidding
    if (action === 'owner-release') {
      if ((u.projects || {})[project] !== 'client') return res.status(403).json({ error: 'owner_only' });
      if (!p.hiredGc) return res.status(409).json({ error: 'no_gc_yet' });
      const reason = clean(b.reason, 500);
      if (reason.length < 3) return res.status(400).json({ error: 'reason_required' });
      const gone = p.hiredGc;
      if (gone.bidId) {
        const raw = await redis(['HGET', `cg:bids:${project}`, gone.bidId]);
        if (raw) { const bid = JSON.parse(raw); bid.status = 'declined'; bid.decidedAt = now(); bid.decidedBy = u.name; await redis(['HSET', `cg:bids:${project}`, bid.id, JSON.stringify(bid)]); }
      }
      if (gone.identifier) {
        const gu = await getJSON(`cg:user:${gone.identifier}`);
        if (gu && gu.projects && gu.projects[project] === 'gc' && !gu.admin) { delete gu.projects[project]; await setJSON(`cg:user:${gu.identifier}`, gu); }
        await redis(['HDEL', `cg:members:${project}`, gone.identifier]);
      }
      await setJSON(`cg:project:${project}`, Object.assign({}, p, { stage: 'bidding', hiredGc: null, startedAt: null, releasedGc: Object.assign({}, gone, { releasedAt: now(), reason }) }));
      await redis(['DEL', `cg:kickoff:${project}`]);
      await notify(req, project, { text: `${u.name} (Owner) released ${gone.company || gone.name} as GC — ${reason}`, targets: ['client', 'gc'], by: u.name, byAccount: u.identifier });
      return res.status(200).json({ ok: true, stage: 'bidding' });
    }

    // ── project details: the owner, or the GC while no owner has joined
    if (action === 'update-meta') {
      const meta = await getProjectMeta(project);
      if (meta.builtin) return res.status(400).json({ error: 'not_supported' });
      const owners = (await projectMembers(project)).filter((m) => m.role === 'client' && m.status === 'active');
      const mine = (u.projects || {})[project];
      if (!(u.admin || mine === 'client' || (mine === 'gc' && !owners.length))) return res.status(403).json({ error: owners.length ? 'owner_only' : 'forbidden' });
      if (clean(b.name, 80)) meta.name = clean(b.name, 80);
      if (['residential', 'commercial'].includes(clean(b.classification, 20))) { meta.classification = clean(b.classification, 20); meta.subtype = ''; }
      if ((SUBTYPES[meta.classification] || []).includes(clean(b.subtype, 30))) meta.subtype = clean(b.subtype, 30);
      if (SCOPES.includes(clean(b.scope, 30))) meta.scope = clean(b.scope, 30);
      meta.updatedAt = now();
      await setJSON(`cg:proj:${project}`, meta);
      return res.status(200).json({ ok: true, meta });
    }

    // ── GC: progress update (phase, % complete, next milestone) — owner is notified
    if (action === 'status') {
      if (!isGC) return res.status(403).json({ error: 'gc_only' });
      const meta = await getProjectMeta(project);
      if (meta.builtin) return res.status(400).json({ error: 'not_supported' });
      meta.status = cleanStatus(b, meta.status);
      await setJSON(`cg:proj:${project}`, meta);
      await notify(req, project, { text: `Progress update: ${meta.status.phase} · ${meta.status.percent}%${meta.status.nextMilestone ? ' · next: ' + meta.status.nextMilestone : ''}`, targets: ['client'], by: u.name, byAccount: u.identifier });
      return res.status(200).json({ ok: true, status: meta.status });
    }

    // ── GC: start project
    if (action === 'start') {
      if (!isGC) return res.status(403).json({ error: 'gc_only' });
      if (p.stage !== 'kickoff') return res.status(409).json({ error: p.stage === 'active' ? 'already_started' : 'no_gc_yet' });
      const doc = (await getJSON(`cg:kickoff:${project}`)) || { items: [] };
      const open = blockers(doc.items);
      if (open.length) return res.status(409).json({ error: 'checklist_incomplete', open: open.map((i) => i.text) });
      const next = Object.assign({}, p, { stage: 'active', startedAt: now(), startedBy: u.name });
      await setJSON(`cg:project:${project}`, next);
      const gcFirst = firstName((p.hiredGc && p.hiredGc.name) || u.name);
      await notify(req, project, { text: `Project started — ${gcFirst} (GC) kicked off ${projectTitle(project)}`, targets: ['client', 'gc'], by: u.name, byAccount: u.identifier });
      return res.status(200).json({ ok: true, stage: 'active', startedAt: next.startedAt });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: String(err.message || err).slice(0, 200) });
  }
}
