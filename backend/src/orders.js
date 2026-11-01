import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { numbersIn, toAscii } from './textutil.js';
import { checkCaption, detectLanguage } from './generate.js';
import { onOrderStatusChange } from './stock.js';

// Item 7. Orders come from comments classified order_intent, leads from interested ones. Facebook does not tell us who
// commented, so an order is "Customer on <post>", with the comment id and a link that opens it on Facebook.
// The orders table keeps its own status words; the API speaks to_review / confirmed / delivered / cancelled.
const TO_DB = { to_review: 'pending', confirmed: 'confirmed', delivered: 'fulfilled', cancelled: 'cancelled' };
const FROM_DB = Object.fromEntries(Object.entries(TO_DB).map(([k, v]) => [v, k]));
export const STATUSES = Object.keys(TO_DB);
// owner-controlled moves only; "undo" is the move back
const MOVES = { to_review: ['confirmed', 'cancelled'], confirmed: ['delivered', 'to_review', 'cancelled'], delivered: ['confirmed'], cancelled: ['to_review'] };
const BATCH = 30;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function fetchAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// A link that opens the comment on Facebook: facebook.com/<page>/posts/<post>?comment_id=<comment>. The demo's
// anonymised ids have no such link.
export function commentUrl(postId, commentId) {
  const post = /^(\d+)_(\d+)$/.exec(String(postId ?? ''));
  const comment = /^\d+_(\d+)$/.exec(String(commentId ?? ''));
  return post && comment ? `https://www.facebook.com/${post[1]}/posts/${post[2]}?comment_id=${comment[1]}` : null;
}

// ---- what the comment says ---------------------------------------------------------------------------
const NUMBER_WORDS = { one: 1, ek: 1, ekta: 1, ekti: 1, two: 2, dui: 2, duita: 2, duto: 2, three: 3, tin: 3, tinta: 3, four: 4, char: 4, charta: 4, five: 5, pach: 5, panch: 5, pachta: 5 };
const UNIT = '(?:ta|ti|pcs?|pieces?|pairs?|jora|set|sets|packets?|jon|ti)';

// A quantity counts only if the text states it: "2 ta", "2 pairs", "quantity 2", "ekta", "one pair".
// A bare number next to "size" is a size, not a quantity.
export function quantityStated(text, q) {
  if (!Number.isInteger(q) || q < 1 || q > 100) return false;
  const t = toAscii(text).toLowerCase();
  if (new RegExp(`(?<!size\\s{0,3})(?<![\\d.])${q}\\s{0,2}${UNIT}\\b`).test(t)) return true;
  if (new RegExp(`(?:quantity|qty|koyta|koita)\\s{0,3}:?\\s{0,3}${q}\\b`).test(t)) return true;
  return Object.entries(NUMBER_WORDS).some(([word, n]) => n === q && new RegExp(`(?<![a-z])${word}\\s+(?:${UNIT.slice(3, -1)}|pair|pcs?)\\b|(?<![a-z])${word}(?:ta|ti)\\b`).test(t));
}

const written = (value, text) => {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v.length > 60) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text.toLowerCase());
};

// Bangladeshi mobile numbers, with or without +88 and with Bangla digits. Found by pattern, never by the model.
export function findPhone(text) {
  const m = toAscii(text).replace(/[\s\-.()]/g, '').match(/(?:\+?88)?(01[3-9]\d{8})(?!\d)/);
  return m ? m[1] : null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, size: { type: ['string', 'null'] }, color: { type: ['string', 'null'] },
          quantity: { type: ['integer', 'null'] }, address: { type: ['string', 'null'] },
        },
        required: ['id', 'size', 'color', 'quantity', 'address'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You read Facebook comments in which customers of a small seller in Bangladesh want to buy something. Comments may be English, Bangla script or Banglish. A comment may be followed by the customer's replies.
For each one (an id and its text) return, ONLY what the text itself says:
- size: the size the customer asks for, exactly as written ("M", "XL", "39"); null if not stated
- color: the color the customer asks for, exactly as written; null if not stated
- quantity: how many they want, as a whole number, only if stated ("2 pair", "ekta", "3 pcs"); null if not stated. A number after the word "size" is a size, not a quantity.
- address: the delivery address if the customer wrote one, exactly as written; null if there is none
Never guess and never fill in a default: null is the right answer when the text does not say.`;

// Everything the model returns is checked against the text: a size, color or address that is not literally there is
// dropped, and a quantity must be stated as one. This is what "never guess missing details" means in code.
export function verifyDetails(raw, text) {
  const addr = String(raw.address ?? '').trim();
  return {
    size: raw.size && written(raw.size, text) ? String(raw.size).trim().slice(0, 20) : null,
    color: raw.color && written(raw.color, text) ? String(raw.color).trim().toLowerCase().slice(0, 30) : null,
    quantity: quantityStated(text, raw.quantity) ? raw.quantity : null,
    address: addr.length >= 8 && text.includes(addr) ? clip(addr, 300) : null,
    phone: findPhone(text),
  };
}

async function extractDetails(items) {
  const input = items.map((i) => `id: ${i.id}\ntext: ${clip(i.text, 700)}`).join('\n---\n');
  const { data } = await completeJSON('order_extraction', {
    messages: [{ role: 'user', content: `${INSTRUCTIONS}\n\nComments:\n${input}` }],
    response_format: { type: 'json_schema', json_schema: { name: 'order_details', schema: SCHEMA } },
  }, { validate: (d) => { if (!Array.isArray(d?.items)) throw new Error('answer has no "items" array'); } });
  const byId = new Map(items.map((i) => [i.id, i]));
  return new Map(data.items.filter((r) => byId.has(r.id)).map((r) => [r.id, verifyDetails(r, byId.get(r.id).text)]));
}

// Products that never need a size.
const NO_SIZE = /bag|backpack|wallet|purse|clutch|pouch|earring|necklace|bangle|bracelet|ring|jewel|watch|scarf|belt|sunglass|mask|dupatta|umbrella|cap\b|hat\b|wax|paper/i;

// What the customer has not told us yet. Quantity is never defaulted to 1: it is simply unknown.
export function missingFor({ size, quantity, phone, address }, productType) {
  return [
    !size && !(productType && NO_SIZE.test(productType)) && 'size', quantity == null && 'quantity', !phone && 'phone', !address && 'address',
  ].filter(Boolean);
}

// ---- creating orders (a stage of the analysis pipeline) -------------------------------------------------
const CANDIDATE_INTENTS = ['order_intent', 'interested'];

async function candidateComments(pageId) {
  const rows = await fetchAll(() => db.from('comments')
    .select('id, post_id, message, intent, size, color, created_time, posts!inner(page_id)')
    .eq('posts.page_id', pageId).in('intent', CANDIDATE_INTENTS).eq('is_page', false).eq('answered', false)
    .not('message', 'is', null).neq('message', '').order('id'));
  const have = new Set((await fetchAll(() => db.from('orders').select('comment_id').eq('page_id', pageId).order('id'))).map((o) => o.comment_id));
  return rows.filter((c) => !have.has(c.id));
}

// Are there order or lead comments that have no order card yet?
export async function hasNewOrderComments(pageId) {
  return (await candidateComments(pageId)).length > 0;
}

// One order per comment. The customer's direct replies under it are attached, so a "size 40, 01712…" reply counts.
// Comments the page already answered, and the page's own replies, are skipped.
export async function createOrders(pageId, { progress } = {}) {
  const todo = await candidateComments(pageId);
  await progress?.(0, todo.length);
  if (!todo.length) return { created: 0, orders: 0, leads: 0, failed: 0, total: 0 };

  const replies = new Map();
  for (const ids of chunks(todo.map((c) => c.id), 100)) {
    const rows = await fetchAll(() => db.from('comments').select('id, parent_id, message, created_time').in('parent_id', ids).eq('is_page', false).not('message', 'is', null).order('created_time'));
    for (const r of rows) replies.set(r.parent_id, [...(replies.get(r.parent_id) ?? []), r.message]);
  }
  const productOf = new Map();
  for (const ids of chunks([...new Set(todo.map((c) => c.post_id))], 100)) {
    const links = await fetchAll(() => db.from('product_posts').select('post_id, product_id').in('post_id', ids).order('post_id'));
    for (const l of links) if (!productOf.has(l.post_id)) productOf.set(l.post_id, l.product_id);
  }
  const typeOf = new Map();
  const productIds = [...new Set(productOf.values())];
  for (const ids of chunks(productIds, 100)) {
    const { data } = await db.from('products').select('id, product_type').in('id', ids);
    for (const p of data ?? []) typeOf.set(p.id, p.product_type);
  }

  const texts = todo.map((c) => ({ id: c.id, text: [c.message, ...(replies.get(c.id) ?? [])].join('\n') }));
  const details = new Map();
  let failed = 0;
  for (const [i, batch] of chunks(texts, BATCH).entries()) {
    try { for (const [id, d] of await extractDetails(batch)) details.set(id, d); }
    catch (e) { failed += batch.length; console.error('order extraction failed:', e.status ?? '', JSON.stringify(e.error ?? e.message)); }
    await progress?.(Math.min((i + 1) * BATCH, todo.length), todo.length);
  }

  const rows = todo.filter((c) => details.has(c.id)).map((c) => {
    const text = texts.find((t) => t.id === c.id).text;
    const d = details.get(c.id);
    // the classifier's own size and color count too, if the text really says them
    const size = d.size ?? (c.size && written(c.size, text) ? c.size : null);
    const color = d.color ?? (c.color && written(c.color, text) ? c.color.toLowerCase() : null);
    const productId = productOf.get(c.post_id) ?? null;
    const fields = { size, color, quantity: d.quantity, phone: d.phone, address: d.address };
    // orders.quantity cannot be empty (NOT NULL DEFAULT 1): 1 is only a placeholder, and "quantity" in missing_fields is what says it is unknown
    return { page_id: pageId, comment_id: c.id, product_id: productId, status: 'pending', ...fields, quantity: fields.quantity ?? 1, missing_fields: missingFor(fields, typeOf.get(productId)) };
  });
  for (const part of chunks(rows, 200)) {
    const { error } = await db.from('orders').insert(part);
    if (error) throw new Error(`orders: ${error.message}`);
  }
  const leads = todo.filter((c) => details.has(c.id) && c.intent === 'interested').length;
  if (!rows.length && failed) throw new Error(`orders: all ${failed} comments failed. Check the server log for the cause.`);
  return { created: rows.length, orders: rows.length - leads, leads, failed, total: todo.length };
}

// ---- reading and changing orders ------------------------------------------------------------------------
async function views(pageId, orderRows) {
  if (!orderRows.length) return [];
  const commentIds = orderRows.map((o) => o.comment_id);
  const comments = new Map();
  const replies = new Map();
  for (const ids of chunks(commentIds, 100)) {
    const rows = await fetchAll(() => db.from('comments').select('id, message, intent, created_time, post_id, posts(id, message)').in('id', ids).order('id'));
    for (const r of rows) comments.set(r.id, r);
    const kids = await fetchAll(() => db.from('comments').select('parent_id, message, created_time').in('parent_id', ids).eq('is_page', false).not('message', 'is', null).order('created_time'));
    for (const k of kids) replies.set(k.parent_id, [...(replies.get(k.parent_id) ?? []), k.message]);
  }
  const postIds = [...new Set([...comments.values()].map((c) => c.post_id))];
  const productOf = new Map();
  for (const ids of chunks(postIds, 100)) {
    const links = await fetchAll(() => db.from('product_posts').select('post_id, product_id').in('post_id', ids).order('post_id'));
    for (const l of links) if (!productOf.has(l.post_id)) productOf.set(l.post_id, l.product_id);
  }
  const products = new Map();
  for (const ids of chunks([...new Set([...productOf.values(), ...orderRows.map((o) => o.product_id).filter(Boolean)])], 100)) {
    const { data } = await db.from('products').select('id, name, product_type').in('id', ids);
    for (const p of data ?? []) products.set(p.id, p);
  }
  return orderRows.map((o) => {
    const c = comments.get(o.comment_id);
    const product = products.get(productOf.get(c?.post_id) ?? o.product_id) ?? null;
    const postName = product?.name ?? (c?.posts?.message ? clip(c.posts.message.split('\n')[0], 60) : 'a photo post');
    const quantity = (o.missing_fields ?? []).includes('quantity') ? null : o.quantity; // see createOrders
    const fields = { size: o.size, quantity, phone: o.phone, address: o.address };
    return {
      id: o.id, kind: c?.intent === 'order_intent' ? 'order' : 'lead', status: FROM_DB[o.status] ?? 'to_review',
      customer: `Customer on ${postName}`, post_name: postName, product: product && { id: product.id, name: product.name, type: product.product_type },
      size: o.size, color: o.color, quantity, phone: o.phone, address: o.address, notes: o.notes,
      missing: missingFor(fields, product?.product_type), comment: c?.message ?? '', followups: replies.get(o.comment_id) ?? [],
      comment_id: o.comment_id, comment_url: commentUrl(c?.post_id, o.comment_id), commented_at: c?.created_time ?? o.created_at, created_at: o.created_at,
    };
  });
}

export async function listOrders(pageId, status) {
  if (status && !STATUSES.includes(status)) throw fail(`status must be one of ${STATUSES.join(', ')}`);
  const rows = await fetchAll(() => db.from('orders').select('*').eq('page_id', pageId).order('created_at', { ascending: false }).order('id'));
  const all = (await views(pageId, rows)).sort((a, b) => b.commented_at.localeCompare(a.commented_at));
  const count = (s, kind) => all.filter((o) => o.status === s && (!kind || o.kind === kind)).length;
  return {
    orders: status ? all.filter((o) => o.status === status) : all,
    counts: { to_review: count('to_review', 'order'), leads: count('to_review', 'lead'), confirmed: count('confirmed'), delivered: count('delivered'), cancelled: count('cancelled') },
  };
}

async function getOne(pageId, id) {
  const { data, error } = await db.from('orders').select('*').eq('id', id).eq('page_id', pageId).maybeSingle();
  if (error) throw error;
  if (!data) throw fail('Order not found.', 404);
  return { row: data, view: (await views(pageId, [data]))[0] };
}

const text = (v, n) => { const t = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim(); return t ? clip(t, n) : null; };

export async function updateOrder(pageId, id, body) {
  const { view } = await getOne(pageId, id);
  const patch = {};
  if ('size' in body) patch.size = text(body.size, 20);
  if ('color' in body) patch.color = text(body.color, 30)?.toLowerCase() ?? null;
  if ('quantity' in body) {
    if (body.quantity === null || body.quantity === '') patch.quantity = null;
    else { const q = Math.floor(Number(toAscii(body.quantity))); if (!Number.isFinite(q) || q < 1 || q > 999) throw fail('Quantity must be a whole number from 1 to 999.'); patch.quantity = q; }
  }
  if ('phone' in body) {
    const t = text(body.phone, 30);
    const digits = t ? toAscii(t).replace(/\D/g, '') : '';
    if (t && (digits.length < 10 || digits.length > 15)) throw fail('That phone number does not look right.');
    patch.phone = t ? (findPhone(t) ?? digits) : null;
  }
  if ('address' in body) patch.address = text(body.address, 300);
  if ('notes' in body) patch.notes = text(body.notes, 300);
  if (!Object.keys(patch).length) throw fail('Nothing to change.');
  const merged = { size: view.size, quantity: view.quantity, phone: view.phone, address: view.address, ...patch };
  patch.missing_fields = missingFor(merged, view.product?.type);
  if ('quantity' in patch && patch.quantity === null) patch.quantity = 1; // placeholder, flagged as missing above
  const { error } = await db.from('orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('page_id', pageId);
  if (error) throw error;
  return (await getOne(pageId, id)).view;
}

export async function setOrderStatus(pageId, id, status) {
  if (!STATUSES.includes(status)) throw fail(`status must be one of ${STATUSES.join(', ')}`);
  const { view } = await getOne(pageId, id);
  if (view.status === status) return view;
  if (view.kind === 'lead' && status !== 'cancelled') throw fail('This is only a lead. Mark it as an order first.', 409);
  if (!MOVES[view.status].includes(status)) throw fail(`An order that is ${view.status.replace('_', ' ')} cannot go to ${status.replace('_', ' ')}.`, 409);
  const { error } = await db.from('orders').update({ status: TO_DB[status], updated_at: new Date().toISOString() }).eq('id', id).eq('page_id', pageId);
  if (error) throw error;
  // confirming takes the order's quantity from stock; moving it back (undo, cancel) puts exactly that back
  let stock_note = null;
  try { stock_note = await onOrderStatusChange(pageId, view, view.status, status); }
  catch (e) { console.error('stock update failed:', e.message); stock_note = 'The order was updated, but its stock could not be changed. Check the product\'s stock.'; }
  return { ...(await getOne(pageId, id)).view, stock_note };
}

// "Mark as order": the owner says this lead is an order. The comment's intent follows, so the home counts agree, and
// classification never overwrites it (comments that have an order card are left alone).
export async function convertToOrder(pageId, id) {
  const { view } = await getOne(pageId, id);
  if (view.kind === 'order') return view;
  const { error } = await db.from('comments').update({ intent: 'order_intent' }).eq('id', view.comment_id);
  if (error) throw error;
  return (await getOne(pageId, id)).view;
}

// ---- "Ask for details": a reply for the owner to copy; nothing is ever sent ---------------------------------
const ASKS = { size: /\bsize\b|সাইজ/i, quantity: /quantity|how many|number of|pieces|pairs|koyta|koita|kotota|koyti|koto\s*(?:ta|pair|jora|piece|pcs|gulo)|kotogulo|কয়\s*(?:টা|টি|জোড়া|পিস)|কত\s*(?:গুলো|টা|টি|পিস|জোড়া)|কতগুলো|পরিমাণ|সংখ্যা/i, phone: /phone|mobile|number|nambar|নম্বর|ফোন|মোবাইল/i, address: /address|thikana|location|ঠিকানা/i };
const REPLY_SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
const LANGUAGE = {
  bangla: 'Write in Bangla script (বাংলা), because the customer wrote in Bangla.',
  banglish: 'Write in Banglish: Bangla words in English letters, the way the customer wrote (for example "apnar size ta bolben?").',
  english: 'Write in simple English, because the customer wrote in English.',
};
const FIELD_NAME = { size: 'the size', quantity: 'how many they want', phone: 'a phone number', address: 'the delivery address' };

export async function suggestReply(pageId, id) {
  const { view } = await getOne(pageId, id);
  if (!view.missing.length) throw fail('Nothing is missing: this order has every detail.', 409);
  const language = detectLanguage(view.comment);
  const asks = view.missing;
  let problems = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { data } = await completeJSON('order_reply', {
      messages: [{ role: 'user', content: `You write a short Facebook reply from a small seller in Bangladesh to a customer's comment about buying${view.product ? ` "${view.product.name}"` : ''}.
THE CUSTOMER WROTE: ${JSON.stringify(clip(view.comment, 400))}
THEY HAVE NOT YET TOLD YOU: ${asks.map((a) => FIELD_NAME[a]).join(', ')}.
RULES (checked by code):
- ${LANGUAGE[language]}
- Thank them in a few words, then ask ONLY for what is missing above, nothing else. At most 2 short sentences, under 240 characters.
- No prices, no delivery charges or times, no promises about stock, no discounts, no numbers at all, no names, no links.
- Plain text.
Return JSON: {"reply": "..."}.${problems.length ? `\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix:\n- ${problems.join('\n- ')}` : ''}` }],
      response_format: { type: 'json_schema', json_schema: { name: 'order_reply', schema: REPLY_SCHEMA } },
    }, { validate: (d) => { if (typeof d?.reply !== 'string') throw new Error('answer has no reply'); } });
    const reply = data.reply.trim();
    problems = checkCaption(reply, { allowedNumbers: new Set(), knownText: view.comment, priceRequired: false, language });
    if (/\d/.test(toAscii(reply)) && !problems.some((p) => p.includes('number'))) problems.push('no numbers at all');
    if (reply.length > 300) problems.push('keep it under 240 characters');
    for (const [field, re] of Object.entries(ASKS)) {
      if (asks.includes(field) && !re.test(reply)) problems.push(`ask for ${FIELD_NAME[field]}`);
      if (!asks.includes(field) && field !== 'quantity' && re.test(reply)) problems.push(`do not ask for ${FIELD_NAME[field]}: the customer already gave it`);
    }
    if (!problems.length) return { reply, language, asks, attempts: attempt };
    console.error(`order reply rejected (attempt ${attempt}/3):`, problems.join(' | '));
  }
  throw fail('Could not write a reply that follows the rules. Please try again.', 422);
}

// ---- CSV for courier booking ----------------------------------------------------------------------------
const cell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; // a spreadsheet must not run a customer's text as a formula
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export function ordersCsv(orders) {
  const header = ['product', 'size', 'color', 'quantity', 'comment_link', 'status', 'date', 'phone', 'address'];
  const rows = orders.map((o) => [o.product?.name ?? o.post_name, o.size, o.color, o.quantity, o.comment_url, o.status, String(o.commented_at ?? '').slice(0, 10), o.phone, o.address]);
  return `${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

export async function exportConfirmed(pageId) {
  const { orders } = await listOrders(pageId, 'confirmed');
  return ordersCsv(orders.filter((o) => o.kind === 'order'));
}
