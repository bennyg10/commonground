// Common Ground — proposal line items, the homeowner's scope checklist, and invoices (Project Budget).
// Line items and invoice details are read by the AI on the page (through /api/analyze) and saved here,
// shape-checked, so every proposal and invoice lands in the same organized format.
import fs from 'node:fs';
import path from 'node:path';
import { redis, getJSON, setJSON, clean, token, rateLimited, notify } from './_lib.js';

const now = () => new Date().toISOString();
const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && Math.abs(n) < 1e9 ? Math.round(n * 100) / 100 : null; };
const STATUSES = ['included', 'partial', 'excluded', 'unclear'];
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_B64 = 4200000;          // ~3 MB file
const MAX_INVOICES = 200;

// ── one-time seed patch: line items + scope for projects seeded before this existed ──
export async function seedPatch(project) {
  await seedV2(project);
  await seedV3(project);
}
// v3: the excavation phase (soil removal / export) is its own item on the homeowner's list, and seeded proposals are refreshed to match
async function seedV3(project) {
  if (await redis(['GET', `cg:seedv3:${project}`])) return;
  const seedPath = path.join(process.cwd(), 'api', '_pages', `${project}-seed.json`);
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const want = (seed.scope || []).find((x) => x.id === 's-excavate');
    const cur = await getJSON(`cg:scope:${project}`);
    if (want && cur && !cur.some((x) => x.id === want.id)) {
      const i = cur.findIndex((x) => x.id === 's-grade');
      cur.splice(i === -1 ? cur.length : i, 0, want);
      await setJSON(`cg:scope:${project}`, cleanScope(cur));
    }
    for (const sb of seed.bids || []) {
      if (!sb.breakdown) continue;
      const raw = await redis(['HGET', `cg:bids:${project}`, sb.id]);
      if (!raw) continue;
      const bid = JSON.parse(raw);
      if (!bid.breakdown || bid.breakdown.source === 'seed') { bid.breakdown = cleanBreakdown(sb.breakdown, 'seed'); await redis(['HSET', `cg:bids:${project}`, sb.id, JSON.stringify(bid)]); }
    }
  }
  await redis(['SET', `cg:seedv3:${project}`, '1']);
}
async function seedV2(project) {
  if (await redis(['GET', `cg:seedv2:${project}`])) return;
  const seedPath = path.join(process.cwd(), 'api', '_pages', `${project}-seed.json`);
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (seed.scope && !(await getJSON(`cg:scope:${project}`))) await setJSON(`cg:scope:${project}`, cleanScope(seed.scope));
    for (const sb of seed.bids || []) {
      if (!sb.breakdown) continue;
      const raw = await redis(['HGET', `cg:bids:${project}`, sb.id]);
      if (!raw) continue;
      const bid = JSON.parse(raw);
      if (!bid.breakdown || !bid.breakdown.at) { bid.breakdown = cleanBreakdown(sb.breakdown, 'seed'); await redis(['HSET', `cg:bids:${project}`, sb.id, JSON.stringify(bid)]); }
    }
  }
  await redis(['SET', `cg:seedv2:${project}`, '1']);
}

// ── scope checklist: what the homeowner asked for ──
export function cleanScope(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).map((x, i) => {
    const o = typeof x === 'string' ? { item: x } : (x || {});
    return { id: clean(o.id, 20) || 's' + (i + 1) + token(2).replace(/[^a-zA-Z0-9]/g, ''), item: clean(o.item, 120), category: clean(o.category, 40) };
  }).filter((x) => x.item);
}
export async function getScope(project) { return (await getJSON(`cg:scope:${project}`)) || []; }
export async function saveScope(project, list) { const s = cleanScope(list); await setJSON(`cg:scope:${project}`, s); return s; }

// ── proposal breakdown (line items) ──
export function cleanBreakdown(b, source) {
  b = b || {};
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 120).map((x, i) => ({
    id: clean(x.id, 20) || 'l' + (i + 1), category: clean(x.category, 50) || 'General', item: clean(x.item, 140), desc: clean(x.desc, 300),
    amount: money(x.amount), optional: x.optional === true, qty: clean(String(x.qty == null ? '' : x.qty), 30),
  })).filter((x) => x.item);
  const ids = new Set(items.map((x) => x.id));
  return {
    items,
    exclusions: (Array.isArray(b.exclusions) ? b.exclusions : []).slice(0, 40).map((x) => clean(String(x), 200)).filter(Boolean),
    allowances: (Array.isArray(b.allowances) ? b.allowances : []).slice(0, 40).map((x) => ({ item: clean(x.item, 140), amount: money(x.amount), unit: clean(x.unit, 40) })).filter((x) => x.item),
    coverage: (Array.isArray(b.coverage) ? b.coverage : []).slice(0, 80).map((x) => ({
      scopeId: clean(x.scopeId, 20), status: STATUSES.includes(x.status) ? x.status : 'unclear',
      lineId: ids.has(clean(x.lineId, 20)) ? clean(x.lineId, 20) : '', note: clean(x.note, 200) })).filter((x) => x.scopeId),
    baseTotal: money(b.baseTotal), total: money(b.total), timeline: clean(b.timeline, 200), terms: clean(b.terms, 300),
    source: source || (b.source === 'seed' ? 'seed' : 'ai'), at: now(),
  };
}
export async function saveBreakdown(project, bidId, breakdown) {
  const raw = await redis(['HGET', `cg:bids:${project}`, bidId]);
  if (!raw) return null;
  const bid = JSON.parse(raw);
  bid.breakdown = cleanBreakdown(breakdown, 'ai');
  if (!bid.amount && bid.breakdown.total) bid.amount = Math.round(bid.breakdown.total);   // uploaded without a price → use the proposal's total
  await redis(['HSET', `cg:bids:${project}`, bidId, JSON.stringify(bid)]);
  return { breakdown: bid.breakdown, amount: bid.amount };
}

// ── invoices ──
export async function listInvoices(project) { return (await getJSON(`cg:invoices:${project}`)) || []; }
async function saveInvoices(project, list) { await setJSON(`cg:invoices:${project}`, list.slice(-MAX_INVOICES)); }
const publicInvoice = (x) => Object.assign({}, x, { fileData: undefined, account: undefined });

export async function uploadInvoice(req, project, u, role, b) {
  if (await rateLimited(`cg:rl:inv:${u.identifier}`, 60, 86400)) return [429, { error: 'too_many' }];
  const type = clean(b.type, 40), data = typeof b.data === 'string' ? b.data : '';
  if (!FILE_TYPES.includes(type)) return [400, { error: 'bad_file_type' }];
  if (!data || data.length > MAX_FILE_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return [413, { error: 'file_too_large' }];
  const list = await listInvoices(project);
  if (list.length >= MAX_INVOICES) return [409, { error: 'too_many_invoices' }];
  const id = 'inv' + Date.now().toString(36) + token(3).replace(/[^a-zA-Z0-9]/g, '');
  await redis(['SET', `cg:file:${id}`, data]);
  const inv = { id, fileName: clean(b.name, 160) || 'invoice', fileType: type, size: Math.round(data.length * 0.75), by: u.name, account: u.identifier, role,
                at: now(), paid: false, status: 'reading', extracted: null };
  list.push(inv); await saveInvoices(project, list);
  await notify(req, project, { text: `${u.name} uploaded an invoice: ${inv.fileName}`, targets: role === 'client' ? ['gc'] : ['client'], by: u.name, byAccount: u.identifier, noEmail: true });
  return [200, { ok: true, invoice: inv }];
}
export function cleanExtracted(x) {
  x = x || {};
  return {
    vendor: clean(x.vendor, 120), number: clean(x.number, 60), date: clean(x.date, 40), total: money(x.total), paidOnDoc: x.paidOnDoc === true,
    items: (Array.isArray(x.items) ? x.items : []).slice(0, 80).map((i) => ({ desc: clean(i.desc, 200), amount: money(i.amount), contractLineId: clean(i.contractLineId, 20), changeOrderId: clean(i.changeOrderId, 60) })).filter((i) => i.desc || i.amount != null),
    notes: clean(x.notes, 400),
  };
}
export async function updateInvoice(project, u, role, b) {
  const list = await listInvoices(project);
  const inv = list.find((x) => x.id === clean(b.id, 40));
  if (!inv) return [404, { error: 'not_found' }];
  if (b.extracted) { inv.extracted = cleanExtracted(b.extracted); inv.status = 'read'; inv.readAt = now(); }
  if (b.failed === true && !inv.extracted) inv.status = 'unread';
  if (b.resolve && typeof b.resolve.key === 'string') {          // a flag the homeowner checked and is OK with
    if (role !== 'client' && !u.admin) return [403, { error: 'owner_only' }];
    const key = clean(b.resolve.key, 80);
    inv.resolved = Object.assign({}, inv.resolved);
    if (b.resolve.clear) delete inv.resolved[key];
    else inv.resolved[key] = { by: u.name, at: now(), note: clean(b.resolve.note, 300) };
  }
  if (typeof b.paid === 'boolean') {
    if (role !== 'client' && !u.admin) return [403, { error: 'owner_only' }];   // only the homeowner marks what they've paid
    inv.paid = b.paid; inv.paidAt = b.paid ? now() : null; inv.paidBy = b.paid ? u.name : null;
  }
  await saveInvoices(project, list);
  return [200, { ok: true, invoice: inv, invoices: list }];
}
export async function deleteInvoice(project, u, role, id) {
  const list = await listInvoices(project);
  const inv = list.find((x) => x.id === clean(id, 40));
  if (!inv) return [404, { error: 'not_found' }];
  if (!(inv.account === u.identifier || role === 'client' || u.admin)) return [403, { error: 'forbidden' }];
  await redis(['DEL', `cg:file:${inv.id}`]);
  const next = list.filter((x) => x.id !== inv.id); await saveInvoices(project, next);
  return [200, { ok: true, invoices: next }];
}
export async function invoiceFile(project, id) {
  const inv = (await listInvoices(project)).find((x) => x.id === clean(id, 40));
  if (!inv) return null;
  const data = await redis(['GET', `cg:file:${inv.id}`]);
  return data ? { inv, data } : null;
}
export { publicInvoice };
