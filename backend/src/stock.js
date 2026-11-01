import * as XLSX from 'xlsx';
import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { toAscii } from './textutil.js';
import { hasColumns } from './schema.js';
import { listCatalog } from './catalog.js';

// Item 21: stock from the owner's own spreadsheet. The sheet is read and matched to the catalog (nothing is saved
// until the owner confirms the preview), stock is kept per variant (product + size + color), confirming an order takes
// from it and undoing puts it back, and the current stock can be downloaded in the owner's own columns.
export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLS = 40;
const FIELDS = ['name', 'size', 'color', 'quantity', 'price', 'sku'];
const DEFAULT_HEADERS = { name: 'Product', size: 'Size', color: 'Color', quantity: 'Quantity', price: 'Price', sku: 'SKU' };
export const DEFAULT_LOW_STOCK = 3;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const stockReady = () => hasColumns('stock_variants', ['product_id', 'size', 'color', 'quantity']);

// ---- reading the file ----------------------------------------------------------------------------
const cellText = (c) => {
  if (!c) return '';
  if (c.t === 'n') return c.v; // numbers stay numbers
  if (c.t === 'd') return c.v instanceof Date ? c.v.toISOString().slice(0, 10) : String(c.w ?? c.v);
  return String(c.w ?? c.v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
};

// A sheet as a grid of cells. A merged block that runs down a single column (a product name over its sizes) is filled
// into every row it covers; titles merged across a row are left alone.
function sheetGrid(ws) {
  if (!ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = Math.min(range.e.r - range.s.r + 1, MAX_ROWS + 50);
  const cols = Math.min(range.e.c - range.s.c + 1, MAX_COLS);
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cellText(ws[XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })])));
  for (const m of ws['!merges'] ?? []) {
    const r0 = m.s.r - range.s.r; const c0 = m.s.c - range.s.c;
    if (m.s.c !== m.e.c || m.e.r <= m.s.r || c0 < 0 || c0 >= cols || r0 < 0 || r0 >= rows) continue;
    for (let r = r0 + 1; r <= Math.min(m.e.r - range.s.r, rows - 1); r++) grid[r][c0] = grid[r0][c0];
  }
  return grid;
}

const filled = (row) => row.filter((c) => c !== '' && c != null).length;
const isTextCell = (c) => typeof c === 'string' && c !== '' && Number.isNaN(Number(toAscii(c).replace(/,/g, '')));

// The header is the first row near the top with several text cells followed by another row of data. Title rows (one
// cell, often merged) and blank rows above it are skipped.
function findHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const row = grid[r];
    const n = filled(row);
    if (n >= 2 && row.filter(isTextCell).length >= Math.ceil(n * 0.7) && grid.slice(r + 1, r + 4).some((x) => filled(x) >= 2)) return r;
  }
  return Math.max(grid.findIndex((r) => filled(r) > 0), 0);
}

export function parseWorkbook(buffer, sheet) {
  if (!buffer?.length) throw fail('That file is empty.');
  if (buffer.length > MAX_BYTES) throw fail('The file must be 5 MB or smaller.');
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', codepage: 65001, cellDates: true, sheetRows: MAX_ROWS + 60 }); }
  catch { throw fail('We could not read that file. Use an Excel (.xlsx) or CSV file.'); }
  if (!wb.SheetNames.length) throw fail('That file has no sheets.');
  const name = wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0];
  const grid = sheetGrid(wb.Sheets[name]);
  if (!grid.some((r) => filled(r) > 0)) throw fail('That sheet is empty. Pick another sheet.');
  const h = findHeader(grid);
  const header = grid[h].map((c) => String(c ?? '').trim());
  const rows = grid.slice(h + 1).map((cells, i) => ({ row: h + 2 + i, cells })).filter((r) => filled(r.cells) > 0);
  if (rows.length > MAX_ROWS) throw fail(`That sheet has more than ${MAX_ROWS} rows. Split it and import in parts.`);
  return { sheets: wb.SheetNames, sheet: name, header, rows, sample: rows.slice(0, 5).map((r) => r.cells) };
}

// ---- which column is which -------------------------------------------------------------------------
const KEYWORDS = {
  name: /product|item|name|naam|nam\b|pronno|পণ্য|নাম|আইটেম/i,
  size: /size|saiz|saij|মাপ|সাইজ/i,
  color: /colou?r|rong|rang|রঙ|রং|কালার/i,
  quantity: /qty|quantity|stock|pcs|piece|mojud|mozud|mojut|poriman|porimap|sonkha|মজুদ|পরিমাণ|সংখ্যা|স্টক/i,
  price: /price|dam|daam|mullo|mulyo|taka|rate|দাম|মূল্য|টাকা/i,
  sku: /sku|code|kod\b|id\b|barcode|কোড/i,
};
const numericShare = (rows, i) => {
  const vals = rows.map((r) => r[i]).filter((v) => v !== '' && v != null);
  return vals.length ? vals.filter((v) => typeof v === 'number' || !Number.isNaN(Number(toAscii(v).replace(/[,\s]|pcs?|tk/gi, '')))).length / vals.length : 0;
};

// What the headers say on their own, with no model: a safety net and a cross-check.
function keywordMapping(header) {
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, null]));
  const used = new Set();
  for (const f of ['sku', 'quantity', 'price', 'size', 'color', 'name']) {
    const i = header.findIndex((h, idx) => !used.has(idx) && KEYWORDS[f].test(h));
    if (i >= 0) { mapping[f] = i; used.add(i); }
  }
  return mapping;
}

const MAP_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries([...FIELDS.map((f) => [f, { type: ['integer', 'null'] }]), ['notes', { type: 'string' }]]),
  required: [...FIELDS, 'notes'],
  additionalProperties: false,
};

// The model reads the header and five sample rows. Whatever it returns is checked against the data: an index must exist,
// a column can serve only one field, and quantity and price columns must actually hold numbers.
export async function mapColumns(parsed) {
  const keyword = keywordMapping(parsed.header);
  let model = null;
  try {
    const table = [parsed.header, ...parsed.sample].map((r, i) => `${i === 0 ? 'headers' : `row ${i}`}: ${JSON.stringify(r.map((c) => clip(String(c), 40)))}`).join('\n');
    const { data } = await completeJSON('stock_mapping', {
      messages: [{ role: 'user', content: `You map the columns of a small seller's stock spreadsheet in Bangladesh. Headers may be Bangla, Banglish or English, and a header cell can be blank when it was merged: then judge from the sample rows.
Columns are numbered from 0. For each field return the column number, or null if the sheet has no such column:
- name: the product name
- size: size (S, M, 38...)
- color: color or colour ("rong")
- quantity: how many are in stock
- price: the selling price
- sku: a product code or id
Each column serves at most one field. Titles, totals and blank rows are not columns. "notes": one short sentence on anything odd.

${table}` }],
      response_format: { type: 'json_schema', json_schema: { name: 'stock_columns', schema: MAP_SCHEMA } },
    }, { validate: (d) => { if (!FIELDS.every((f) => f in d)) throw new Error('answer is missing a field'); } });
    model = data;
  } catch (e) { console.error('stock mapping failed, using the headers alone:', e.status ?? '', JSON.stringify(e.error ?? e.message)); }

  const cols = parsed.header.length;
  const used = new Set();
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, null]));
  for (const f of FIELDS) {
    const pick = [model?.[f], keyword[f]].find((i) => Number.isInteger(i) && i >= 0 && i < cols && !used.has(i));
    if (pick == null) continue;
    const numeric = numericShare(parsed.sample, pick);
    if ((f === 'quantity' || f === 'price') && numeric < 0.6) continue; // not a number column
    if (f === 'name' && numeric > 0.6) continue;
    mapping[f] = pick;
    used.add(pick);
  }
  return { mapping, source: model ? 'model' : 'headers', notes: model?.notes ?? null };
}

// ---- turning rows into stock lines ---------------------------------------------------------------
const TOTAL = /^\s*(?:grand\s*total|sub\s*total|total|totals|sum|মোট|সর্বমোট|mot|sob\s*mot|jomot|ekun)\b/i;
const key = (s) => toAscii(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); // the u flag: without it \p is just the letter p
const whole = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  const t = toAscii(v).replace(/[,\s]|pcs?|pieces?|ta\b|টি|পিস/gi, '');
  return /^-?\d+$/.test(t) ? Number(t) : NaN;
};
const money = (v) => {
  const n = typeof v === 'number' ? v : Number(toAscii(v).replace(/[,\s৳]|tk\.?|taka|bdt/gi, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const normSize = (v) => String(typeof v === 'number' ? v : toAscii(v)).trim().replace(/\.0$/, '').toUpperCase().slice(0, 20);

export function extractRows(parsed, mapping) {
  const at = (cells, f) => (mapping[f] == null ? '' : cells[mapping[f]] ?? '');
  const lines = [];
  const ignored = [];
  const problems = [];
  const seen = new Map();
  for (const { row, cells } of parsed.rows) {
    const name = String(at(cells, 'name')).trim();
    const qtyRaw = at(cells, 'quantity');
    if (cells.some((c) => typeof c === 'string' && TOTAL.test(c))) { ignored.push({ row, reason: 'a totals row' }); continue; }
    if (!name) {
      ignored.push({ row, reason: qtyRaw !== '' ? 'no product name (a total or a leftover cell)' : 'no product name' });
      continue;
    }
    const quantity = qtyRaw === '' ? NaN : whole(qtyRaw);
    const line = { row, name: clip(name, 120), size: normSize(at(cells, 'size')), color: String(at(cells, 'color')).trim().toLowerCase().slice(0, 30), quantity, price: money(at(cells, 'price')), sku: String(at(cells, 'sku')).trim().slice(0, 40) || null };
    const bad = [];
    if (qtyRaw === '') bad.push('no quantity');
    else if (!Number.isFinite(quantity)) bad.push(`"${clip(String(qtyRaw), 20)}" is not a whole number`);
    else if (quantity < 0) bad.push('the quantity is negative');
    else if (quantity > 1_000_000) bad.push('the quantity is too large');
    const dup = `${key(name)}|${line.size}|${line.color}`;
    if (seen.has(dup)) bad.push(`the same product, size and color as row ${seen.get(dup)}`);
    else seen.set(dup, row);
    if (bad.length) problems.push({ row, name: line.name, message: bad.join('; ') });
    else lines.push(line);
  }
  return { lines, ignored, problems };
}

// ---- matching the sheet's products to the catalog -----------------------------------------------------
const bigrams = (s) => { const t = key(s).replace(/\s/g, ''); const out = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) ?? 0) + 1); } return out; };
export function similarity(a, b) {
  const x = bigrams(a); const y = bigrams(b);
  let both = 0; let total = 0;
  for (const [g, n] of x) both += Math.min(n, y.get(g) ?? 0);
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  return total ? (2 * both) / total : 0;
}
const HIGH = 0.88; // the names are practically the same: matched on their own
const MAYBE = 0.5; // close enough for the model to judge

const MATCH_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, product_id: { type: ['string', 'null'] }, confidence: { type: 'number' } }, required: ['key', 'product_id', 'confidence'], additionalProperties: false } } },
  required: ['items'],
  additionalProperties: false,
};

async function askModel(uncertain) {
  const out = new Map();
  for (let i = 0; i < uncertain.length; i += 15) {
    const batch = uncertain.slice(i, i + 15);
    try {
      const { data } = await completeJSON('stock_matching', {
        messages: [{ role: 'user', content: `A seller's stock sheet lists products by name. For each sheet name decide which catalog product, if any, is the SAME item (spelling, spacing, word order and language may differ; a different color or style is a different product). Answer product_id from the candidates, or null if none is the same item, with a confidence from 0 to 1.
${batch.map((b) => `key: ${b.key}\nsheet name: ${JSON.stringify(b.name)}\ncandidates: ${JSON.stringify(b.candidates.map((c) => ({ id: c.id, name: c.name, phrase: c.phrase })))}`).join('\n---\n')}` }],
        response_format: { type: 'json_schema', json_schema: { name: 'stock_matches', schema: MATCH_SCHEMA } },
      }, { validate: (d) => { if (!Array.isArray(d?.items)) throw new Error('answer has no items'); } });
      const byKey = new Map(batch.map((b) => [b.key, b]));
      for (const r of data.items) {
        const b = byKey.get(r.key);
        if (!b) continue;
        const ok = r.product_id && b.candidates.some((c) => c.id === r.product_id); // the model may only choose a candidate it was shown
        out.set(r.key, { product_id: ok ? r.product_id : null, confidence: ok ? Math.max(0, Math.min(1, Number(r.confidence) || 0)) : 0 });
      }
    } catch (e) { console.error('stock matching failed:', e.status ?? '', JSON.stringify(e.error ?? e.message)); }
  }
  return out;
}

async function matchGroups(pageId, lines) {
  const groups = new Map();
  for (const l of lines) {
    const k = key(l.name);
    if (!groups.has(k)) groups.set(k, { key: k, name: l.name, lines: [] });
    groups.get(k).lines.push(l);
  }
  const { products } = await listCatalog(pageId);
  const skuOf = new Map();
  if (await stockReady()) {
    const { data } = await db.from('stock_variants').select('product_id, sku').eq('page_id', pageId).not('sku', 'is', null);
    for (const v of data ?? []) skuOf.set(v.sku.toLowerCase(), v.product_id);
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  const scored = [...groups.values()].map((g) => {
    const candidates = products.map((p) => ({ id: p.id, name: p.name, phrase: p.phrase, score: Math.max(similarity(g.name, p.name), p.phrase ? similarity(g.name, p.phrase) : 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 5);
    const sku = g.lines.map((l) => l.sku && skuOf.get(l.sku.toLowerCase())).find(Boolean);
    // Letter-pair similarity cannot compare Bangla with Latin letters: a Bangla name is judged by the model against the
    // catalog's most-posted products instead.
    const bangla = /[ঀ-৿]/.test(g.name);
    return { ...g, bangla, candidates: bangla ? products.slice(0, 60).map((p) => ({ id: p.id, name: p.name, phrase: p.phrase, score: 0 })) : candidates, sku };
  });
  const uncertain = scored.filter((g) => !g.sku && (g.bangla || (g.candidates[0]?.score < HIGH && g.candidates[0]?.score >= MAYBE)))
    .map((g) => ({ key: g.key, name: g.name, candidates: g.bangla ? g.candidates : g.candidates.slice(0, 3) }));
  const judged = uncertain.length ? await askModel(uncertain) : new Map();

  return scored.map((g) => {
    const top = g.candidates[0];
    let match = null;
    if (g.sku) match = { product_id: g.sku, confidence: 1, level: 'high', via: 'code' };
    else if (top?.score >= HIGH) match = { product_id: top.id, confidence: Math.round(top.score * 100) / 100, level: 'high', via: 'name' };
    else if (judged.get(g.key)?.product_id) { const j = judged.get(g.key); match = { product_id: j.product_id, confidence: Math.round(j.confidence * 100) / 100, level: j.confidence >= 0.8 ? 'likely' : 'ask', via: 'model' }; }
    else if (!g.bangla && top?.score >= MAYBE) match = { product_id: top.id, confidence: Math.round(top.score * 100) / 100, level: 'ask', via: 'name' };
    const product = match && byId.get(match.product_id);
    return {
      key: g.key, name: g.name, variants: g.lines.map(({ row, size, color, quantity, price, sku }) => ({ row, size, color, quantity, price, sku })),
      match: match && product ? { ...match, name: product.name } : null,
      candidates: g.candidates.filter((c) => c.score >= 0.3 || g.bangla).slice(0, 3).map((c) => ({ id: c.id, name: c.name, score: Math.round(c.score * 100) / 100 })),
      action: match && product ? 'update' : 'create',
    };
  });
}

// Spellings of one product ("canva sneaker", "canvas sneakers") that land on the same catalog product become one group.
// Within a group the same size and color twice is a mistake in the sheet: the first is kept, the repeat is set aside.
export async function matchLines(pageId, lines) {
  const raw = await matchGroups(pageId, lines);
  const byProduct = new Map();
  const groups = [];
  for (const g of raw) {
    const id = g.match && g.match.level !== 'ask' ? g.match.product_id : null;
    const home = id && byProduct.get(id);
    if (home) { home.variants.push(...g.variants); home.also = [...(home.also ?? []), g.name]; }
    else { if (id) byProduct.set(id, g); groups.push(g); }
  }
  const repeats = [];
  for (const g of groups) {
    const seen = new Map();
    g.variants = g.variants.filter((v) => {
      const k = `${v.size}|${v.color}`;
      if (!seen.has(k)) { seen.set(k, v.row); return true; }
      repeats.push({ row: v.row, name: g.name, message: `the same product, size and color as row ${seen.get(k)}` });
      return false;
    });
  }
  groups.sort((a, b) => (a.match?.level === 'high' ? 1 : 0) - (b.match?.level === 'high' ? 1 : 0) || a.name.localeCompare(b.name));
  return { groups, repeats };
}

// The owner's header words and column order, kept so the Excel download looks like their own sheet.
export const layoutOf = (parsed, mapping) => ({
  headers: Object.fromEntries(FIELDS.filter((f) => mapping[f] != null).map((f) => [f, parsed.header[mapping[f]] || DEFAULT_HEADERS[f]])),
  order: FIELDS.filter((f) => mapping[f] != null).sort((a, b) => mapping[a] - mapping[b]),
});

// Everything the preview screen shows. Reads and matches only: nothing is written.
export async function previewImport(pageId, { buffer, sheet, mapping: given }) {
  const parsed = parseWorkbook(buffer, sheet);
  const mapped = given ? { mapping: FIELDS.reduce((m, f) => ({ ...m, [f]: Number.isInteger(given[f]) && given[f] < parsed.header.length ? given[f] : null }), {}), source: 'owner', notes: null } : await mapColumns(parsed);
  if (mapped.mapping.name == null || mapped.mapping.quantity == null) {
    return { sheets: parsed.sheets, sheet: parsed.sheet, header: parsed.header, sample: parsed.sample, mapping: mapped.mapping, mapping_source: mapped.source, notes: mapped.notes, groups: [], ignored: [], problems: [], needs_mapping: true, layout: null };
  }
  const { lines, ignored, problems } = extractRows(parsed, mapped.mapping);
  const { groups, repeats } = lines.length ? await matchLines(pageId, lines) : { groups: [], repeats: [] };
  problems.push(...repeats);
  const existing = await variantsByProduct(pageId, groups.map((g) => g.match?.product_id).filter(Boolean));
  return {
    sheets: parsed.sheets, sheet: parsed.sheet, header: parsed.header, sample: parsed.sample, mapping: mapped.mapping, mapping_source: mapped.source, notes: mapped.notes,
    groups: groups.map((g) => ({ ...g, current: g.match ? existing.get(g.match.product_id) ?? [] : [] })),
    ignored, problems: problems.sort((a, b) => a.row - b.row), needs_mapping: false, layout: layoutOf(parsed, mapped.mapping),
    totals: { rows: lines.length, products: groups.length, matched: groups.filter((g) => g.match?.level === 'high').length, to_confirm: groups.filter((g) => g.match && g.match.level !== 'high').length, new: groups.filter((g) => !g.match).length },
  };
}

// ---- stock per variant ------------------------------------------------------------------------------
async function variantsByProduct(pageId, productIds) {
  const out = new Map();
  if (!productIds.length || !(await stockReady())) return out;
  const { data } = await db.from('stock_variants').select('product_id, size, color, quantity, sku').eq('page_id', pageId).in('product_id', productIds).order('size');
  for (const v of data ?? []) out.set(v.product_id, [...(out.get(v.product_id) ?? []), { size: v.size, color: v.color, quantity: v.quantity, sku: v.sku }]);
  return out;
}

export async function getVariants(pageId, productId) {
  return (await variantsByProduct(pageId, [productId])).get(productId) ?? [];
}

const totalOf = (variants) => variants.reduce((n, v) => n + v.quantity, 0);

// After stock changes: the product's total follows, and the status follows the total. Reaching 0 marks it sold out
// (so its caption updates, item 8, are offered); stock coming back to a sold-out product restocks it.
async function syncProduct(pageId, productId, before) {
  const variants = await getVariants(pageId, productId);
  const after = totalOf(variants);
  const { data: p } = await db.from('products').select('status').eq('id', productId).eq('page_id', pageId).single();
  let status = p.status;
  let became = null;
  if (variants.length && after === 0 && status !== 'sold_out') { status = 'sold_out'; became = 'sold_out'; }
  else if (after > 0 && status === 'sold_out' && before === 0) { status = 'in_stock'; became = 'restocked'; }
  const patch = { status, updated_at: new Date().toISOString(), ...((await hasColumns('products', ['stock'])) && { stock: variants.length ? after : null }) };
  const { error } = await db.from('products').update(patch).eq('id', productId).eq('page_id', pageId);
  if (error) throw error;
  return { before, after, became };
}

const cleanVariant = (v) => {
  const quantity = Number(v.quantity);
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1_000_000) throw fail('Every quantity must be a whole number, 0 or more.');
  // a code is only written when one is given: editing a quantity must not wipe the product's code
  return { size: normSize(v.size ?? ''), color: String(v.color ?? '').trim().toLowerCase().slice(0, 30), quantity, ...(v.sku ? { sku: String(v.sku).trim().slice(0, 40) } : {}) };
};

async function writeVariants(pageId, productId, variants, { replace }) {
  if (!(await stockReady())) throw fail('Stock tracking needs db/008_stock.sql to be run first.', 409);
  const before = totalOf(await getVariants(pageId, productId));
  const rows = variants.map(cleanVariant).map((v) => ({ page_id: pageId, product_id: productId, ...v, updated_at: new Date().toISOString() }));
  // one upsert for lines that carry a code and one for those that do not, so no line is written with keys it never had
  for (const part of [rows.filter((r) => 'sku' in r), rows.filter((r) => !('sku' in r))]) {
    if (!part.length) continue;
    const { error } = await db.from('stock_variants').upsert(part, { onConflict: 'product_id,size,color' });
    if (error) throw error;
  }
  if (replace) {
    const keep = new Set(rows.map((r) => `${r.size}|${r.color}`));
    const { data } = await db.from('stock_variants').select('id, size, color').eq('product_id', productId);
    const drop = (data ?? []).filter((v) => !keep.has(`${v.size}|${v.color}`)).map((v) => v.id);
    if (drop.length) await db.from('stock_variants').delete().in('id', drop);
  }
  return syncProduct(pageId, productId, before);
}

// "Edit stock" on the catalog screen: the list given becomes the product's stock.
export const setVariants = (pageId, productId, variants) => writeVariants(pageId, productId, variants, { replace: true });

// ---- confirming an import ---------------------------------------------------------------------------------
export async function applyImport(pageId, { groups, layout }) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 2000) throw fail('There is nothing to import.');
  if (!(await stockReady())) throw fail('Stock tracking needs db/008_stock.sql to be run first.', 409);
  const known = new Set((await listCatalog(pageId)).products.map((p) => p.id));
  const result = { updated: 0, created: 0, variants: 0, skipped: 0, sold_out: [], restocked: [] };
  for (const g of groups) {
    if (g.action === 'skip') { result.skipped++; continue; }
    const variants = (g.variants ?? []).slice(0, 500).map((v) => ({ size: v.size, color: v.color, quantity: v.quantity, sku: v.sku }));
    if (!variants.length) continue;
    let productId = g.product_id;
    let name = g.name;
    if (g.action === 'update') {
      if (!known.has(productId)) throw fail(`"${clip(g.name, 40)}" was matched to a product that is not in your catalog.`);
      name = (await db.from('products').select('name').eq('id', productId).single()).data.name;
    } else if (g.action === 'create') {
      const prices = (g.variants ?? []).map((v) => v.price).filter((p) => Number.isFinite(p) && p > 0);
      const sizes = [...new Set(variants.map((v) => normSize(v.size)).filter(Boolean))].slice(0, 12);
      const colors = [...new Set(variants.map((v) => String(v.color ?? '').trim().toLowerCase()).filter(Boolean))].slice(0, 8);
      const cols = await hasColumns('products', ['source']);
      const { data, error } = await db.from('products').insert({ page_id: pageId, name: clip(String(g.name ?? '').trim(), 120) || 'New product', price: prices[0] ?? null, sizes, colors, status: 'in_stock', ...(cols && { source: 'uploaded' }) }).select('id').single();
      if (error) throw error;
      productId = data.id;
      known.add(productId);
    } else throw fail('Each product needs an action: update, create or skip.');
    const change = await writeVariants(pageId, productId, variants, { replace: false });
    if (g.action === 'update') {
      const price = (g.variants ?? []).map((v) => v.price).find((p) => Number.isFinite(p) && p > 0);
      if (price) await db.from('products').update({ price }).eq('id', productId).is('price', null); // an owner's price is never overwritten
    }
    result[g.action === 'create' ? 'created' : 'updated']++;
    result.variants += variants.length;
    if (change.became === 'sold_out') result.sold_out.push(name);
    if (change.became === 'restocked') result.restocked.push(name);
  }
  if (layout?.order?.length && await hasColumns('pages', ['stock_layout'])) await db.from('pages').update({ stock_layout: layout }).eq('id', pageId);
  return result;
}

// ---- orders take stock, undoing puts it back ------------------------------------------------------------
const ACTIVE = new Set(['confirmed', 'delivered']);

// Called when an order changes status. Entering confirmed/delivered takes the order's quantity from the matching
// variant; leaving them restores exactly what was taken. Returns a sentence for the owner, or null when nothing applies.
export async function onOrderStatusChange(pageId, order, from, to) {
  const was = ACTIVE.has(from);
  const is = ACTIVE.has(to);
  if (was === is || !(await stockReady())) return null;
  if (was && !is) return restoreMove(pageId, order);
  if (!order.product?.id) return 'Stock not changed: this order is not linked to a catalog product.';
  const { data: have } = await db.from('stock_moves').select('id').eq('order_id', order.id).maybeSingle();
  if (have) return null; // already counted
  const variants = await db.from('stock_variants').select('id, size, color, quantity').eq('product_id', order.product.id).then((r) => r.data ?? []);
  if (!variants.length) return null; // this product's stock is not tracked
  if (order.quantity == null) return 'Stock not changed: the customer did not say how many. Add the quantity and confirm again.';
  const size = order.size ? normSize(order.size) : null;
  const color = order.color ? order.color.toLowerCase() : null;
  let pick = variants.filter((v) => (!size || v.size === size) && (!color || v.color === color));
  if (!size && !color && variants.length === 1) pick = variants;
  if (pick.length !== 1) return pick.length === 0 ? `Stock not changed: no stock row for ${[size && `size ${size}`, color].filter(Boolean).join(', ') || 'this order'}.` : 'Stock not changed: pick the size or color on the order first.';
  const v = pick[0];
  const take = Math.min(order.quantity, v.quantity);
  if (take > 0) {
    const before = totalOf(await getVariants(pageId, order.product.id));
    await db.from('stock_variants').update({ quantity: v.quantity - take, updated_at: new Date().toISOString() }).eq('id', v.id);
    await db.from('stock_moves').insert({ page_id: pageId, order_id: order.id, product_id: order.product.id, variant_id: v.id, quantity: take });
    const change = await syncProduct(pageId, order.product.id, before);
    const label = [v.size && `size ${v.size}`, v.color].filter(Boolean).join(', ') || 'stock';
    return `Stock for ${order.product.name} (${label}): ${v.quantity} → ${v.quantity - take}${take < order.quantity ? `. Only ${take} were in stock, ${order.quantity - take} short` : ''}${change.became === 'sold_out' ? '. That was the last one: the product is now marked sold out' : ''}.`;
  }
  return `Stock not changed: none in stock for ${[v.size && `size ${v.size}`, v.color].filter(Boolean).join(', ') || 'this product'}.`;
}

async function restoreMove(pageId, order) {
  const { data: move } = await db.from('stock_moves').select('id, variant_id, product_id, quantity').eq('order_id', order.id).maybeSingle();
  if (!move) return null;
  const before = totalOf(await getVariants(pageId, move.product_id));
  if (move.variant_id) {
    const { data: v } = await db.from('stock_variants').select('id, quantity').eq('id', move.variant_id).maybeSingle();
    if (v) await db.from('stock_variants').update({ quantity: v.quantity + move.quantity, updated_at: new Date().toISOString() }).eq('id', v.id);
  }
  await db.from('stock_moves').delete().eq('id', move.id);
  const change = await syncProduct(pageId, move.product_id, before);
  return `Stock restored: ${move.quantity} put back${change.became === 'restocked' ? ` and ${order.product?.name ?? 'the product'} is back in stock` : ''}.`;
}

// ---- alerts on Home ---------------------------------------------------------------------------------------
export async function lowStockThreshold(pageId) {
  if (!(await hasColumns('pages', ['low_stock_threshold']))) return DEFAULT_LOW_STOCK;
  const { data } = await db.from('pages').select('low_stock_threshold').eq('id', pageId).maybeSingle();
  return data?.low_stock_threshold ?? DEFAULT_LOW_STOCK;
}

export async function setLowStockThreshold(pageId, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw fail('The low-stock level must be a whole number from 0 to 1000.');
  if (!(await hasColumns('pages', ['low_stock_threshold']))) throw fail('This setting needs db/008_stock.sql to be run first.', 409);
  const { error } = await db.from('pages').update({ low_stock_threshold: n }).eq('id', pageId);
  if (error) throw error;
  return { low_stock_threshold: n };
}

export async function stockAlerts(pageId) {
  const threshold = await lowStockThreshold(pageId);
  if (!(await stockReady())) return { ready: false, threshold, low: [], sold_out: [] };
  const { data } = await db.from('stock_variants').select('product_id, quantity').eq('page_id', pageId);
  const totals = new Map();
  for (const v of data ?? []) totals.set(v.product_id, (totals.get(v.product_id) ?? 0) + v.quantity);
  const ids = [...totals.keys()];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data: ps } = await db.from('products').select('id, name, status').in('id', ids.slice(i, i + 150));
    for (const p of ps ?? []) names.set(p.id, p);
  }
  const rows = ids.map((id) => ({ id, name: names.get(id)?.name, status: names.get(id)?.status, stock: totals.get(id) })).filter((r) => r.name);
  return {
    ready: true, threshold,
    low: rows.filter((r) => r.stock > 0 && r.stock <= threshold && r.status !== 'sold_out').sort((a, b) => a.stock - b.stock).slice(0, 5),
    sold_out: rows.filter((r) => r.stock === 0).slice(0, 5),
  };
}

// ---- Excel download in the owner's own columns ----------------------------------------------------------------
export const excelRows = (layout, lines) => {
  const order = layout?.order?.length ? layout.order : FIELDS;
  const headers = { ...DEFAULT_HEADERS, ...(layout?.headers ?? {}) };
  return [order.map((f) => headers[f]), ...lines.map((l) => order.map((f) => l[f] ?? ''))];
};

export function excelBuffer(layout, lines) {
  const ws = XLSX.utils.aoa_to_sheet(excelRows(layout, lines));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export async function exportStock(pageId) {
  if (!(await stockReady())) throw fail('Stock tracking needs db/008_stock.sql to be run first.', 409);
  const { data: variants } = await db.from('stock_variants').select('product_id, size, color, quantity, sku').eq('page_id', pageId).order('product_id').order('size');
  const ids = [...new Set((variants ?? []).map((v) => v.product_id))];
  const prods = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await db.from('products').select('id, name, price').in('id', ids.slice(i, i + 150));
    for (const p of data ?? []) prods.set(p.id, p);
  }
  const lines = (variants ?? []).map((v) => ({ name: prods.get(v.product_id)?.name ?? '', size: v.size, color: v.color, quantity: v.quantity, price: prods.get(v.product_id)?.price ?? '', sku: v.sku ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));
  const layout = (await hasColumns('pages', ['stock_layout'])) ? (await db.from('pages').select('stock_layout').eq('id', pageId).maybeSingle()).data?.stock_layout : null;
  return { buffer: excelBuffer(layout, lines), count: lines.length, layout };
}
