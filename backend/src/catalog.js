import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { numbersIn, toAscii } from './textutil.js';
import { hasColumns } from './schema.js';
import { showableUrl } from './photos.js';

// Only the newest tagged posts are read: what a seller sells today matters more than what they sold years ago,
// and every post costs model time. CATALOG_POST_LIMIT widens it.
const POST_LIMIT = Number(process.env.CATALOG_POST_LIMIT) || 800;
const BATCH = 40;
export const STATUSES = ['in_stock', 'pre_order', 'sold_out'];

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

// Columns migration 006 adds. Each one the database lacks is simply left out.
async function optionalColumns() {
  const [phrase, offer, stock, source] = await Promise.all(
    ['product_phrase', 'offer', 'stock', 'source'].map((c) => hasColumns('products', [c])));
  return { product_phrase: phrase, offer, stock, source };
}
export const catalogReady = () => hasColumns('products', ['product_phrase', 'offer', 'stock', 'source']);

// ---- reading what the model extracted ----------------------------------------------------------
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          name: { type: 'string' },
          price: { type: ['number', 'null'] },
          sizes: { type: 'array', items: { type: 'string' } },
          colors: { type: 'array', items: { type: 'string' } },
          pre_order: { type: 'boolean' },
        },
        required: ['post_id', 'name', 'price', 'sizes', 'colors', 'pre_order'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You read Facebook captions from a small seller in Bangladesh and write down what each post says about the product. Captions may be English, Bangla script or Banglish.
For each post (an id, its caption, and a short description of the photo) return:
- post_id: copied exactly
- name: a short product name in English, 2 to 6 words, e.g. "White chunky platform sneakers". No price, no size, no marketing words.
- price: the price in taka if the caption states a price FOR THIS PRODUCT (for example "Tk 950", "950/-", "দাম ১২০০"), as a number; otherwise null. Never guess, never use a discount percentage or a phone number.
- sizes: sizes written in the caption, exactly as written ("M", "XL", "38", "36-40"); empty list if none.
- colors: colors written in the caption, exactly as written; empty list if none. Do not add colors you only see in the photo.
- pre_order: true only if the caption says it is a pre-order.
When the caption does not say something, leave it empty or null. An empty answer is correct.`;

// Everything the model returns is checked against the caption text itself: a price, size or color that is not
// literally written there is dropped. This is what "never guess" means in code.
// A number in the caption is only a price if it is not the delivery charge, a discount or a percentage.
const NOT_A_PRICE = /deliver|shipping|charge|%|\boff\b|discount|ডেলিভারি|চার্জ|ছাড়/i;
function priceIsStated(text, price) {
  const plain = toAscii(text).replace(/(\d),(?=\d{3})/g, '$1');
  const re = new RegExp(`(?<![\\d.])${price}(?![\\d])`, 'g');
  for (const m of plain.matchAll(re)) {
    const near = plain.slice(Math.max(0, m.index - 12), m.index + String(price).length + 8);
    if (!NOT_A_PRICE.test(near)) return true;
  }
  return false;
}

export function verifyFacts(raw, caption) {
  const text = String(caption ?? '');
  const lower = text.toLowerCase();
  const nums = numbersIn(text);
  const price = typeof raw.price === 'number' && raw.price > 0 && nums.has(String(raw.price)) && priceIsStated(text, raw.price) ? raw.price : null;
  const written = (w) => {
    const word = String(w ?? '').trim().toLowerCase();
    if (!word || word.length > 24) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(lower);
  };
  return {
    name: clip(String(raw.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim(), 80),
    price,
    sizes: [...new Set((raw.sizes || []).map((s) => String(s).trim()).filter(written))].slice(0, 12),
    colors: [...new Set((raw.colors || []).map((c) => String(c).trim().toLowerCase()).filter(written))].slice(0, 8),
    pre_order: !!raw.pre_order && /pre-?\s?order|প্রি-?\s?অর্ডার/i.test(text),
  };
}

async function extractFacts(batch) {
  const input = batch.map((p) => `post_id: ${p.id}\nphoto shows: ${p.phrase || p.type}\ncaption: ${clip(p.caption, 600) || '(none)'}`).join('\n---\n');
  const { data } = await completeJSON('catalog_extraction', {
    messages: [{ role: 'user', content: `${INSTRUCTIONS}\n\nPosts:\n${input}` }],
    response_format: { type: 'json_schema', json_schema: { name: 'post_products', schema: FACTS_SCHEMA } },
  }, { validate: (d) => { if (!Array.isArray(d?.items)) throw new Error('answer has no "items" array'); } });
  const byId = new Map(batch.map((p) => [p.id, p]));
  const out = new Map();
  for (const item of data.items) if (byId.has(item.post_id) && !out.has(item.post_id)) out.set(item.post_id, verifyFacts(item, byId.get(item.post_id).caption));
  return out;
}

// ---- deciding which posts show the same product -------------------------------------------------
const STOP = new Set(['with', 'and', 'the', 'an', 'of', 'in', 'for', 'on', 'to', 'set', 'pair', 'style', 'look', 'pack', 'a']);
const COLOR = new Set(['red', 'blue', 'green', 'black', 'white', 'pink', 'yellow', 'purple', 'orange', 'brown', 'grey', 'gray', 'beige', 'maroon',
  'navy', 'golden', 'gold', 'silver', 'cream', 'offwhite', 'off', 'tan', 'khaki', 'mustard', 'burgundy', 'lavender', 'peach', 'mint', 'olive', 'coral', 'rose', 'teal', 'multicolor', 'light', 'dark', 'pale']);
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map(singular);

// The words that say which product it is: no colors (one product comes in several), no filler, not the type itself.
export const identityTokens = (phrase, type) => new Set(words(phrase).filter((w) => !STOP.has(w) && !COLOR.has(w) && w !== singular(String(type ?? '').toLowerCase()) && w.length > 2));
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
};
const captionWords = (t) => new Set(String(t ?? '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));

const MIN_IDENTITY = 2; // a phrase of fewer distinctive words ("sneakers") is too generic to merge on
const SAME_PHRASE = 0.85; // colors count here: a white and a light blue pair are two products
const COPY_CAPTION = 0.9; // reposts of one product share a caption...
const COPY_PHRASE = 0.6; // ...but the page also reuses one boilerplate caption for different products, so the photos must agree too
const MIN_CAPTION_WORDS = 12;

// Every word of the photo phrase except filler: colors and the type stay, because they tell products apart.
export const fullTokens = (phrase) => new Set(words(phrase).filter((w) => !STOP.has(w) && w.length > 2));

// Two posts show the same product when the type matches and the photo phrases (colors included) are nearly the
// same with enough distinctive words, or the captions are near copies AND the phrases roughly agree (a repost or
// restock). Stated prices that differ keep them apart. Wrong merges are worse than missed ones: a merged product
// is what "sold out" edits are proposed for.
export function sameProduct(a, b) {
  if (a.type !== b.type) return false;
  if (a.price != null && b.price != null && a.price !== b.price) return false;
  const phraseSim = jaccard(a.full, b.full);
  if (a.identity.size >= MIN_IDENTITY && b.identity.size >= MIN_IDENTITY && phraseSim >= SAME_PHRASE) return true;
  return a.words.size >= MIN_CAPTION_WORDS && b.words.size >= MIN_CAPTION_WORDS && jaccard(a.words, b.words) >= COPY_CAPTION && phraseSim >= COPY_PHRASE;
}

// Each post joins the first group whose FIRST post it matches. Comparing to one post (not to any member) stops a
// chain of look-alikes from drifting into a group of different products.
function cluster(items) {
  const groups = [];
  for (const item of [...items].sort((a, b) => b.created_time.localeCompare(a.created_time))) {
    const home = groups.find((g) => sameProduct(g[0], item));
    if (home) home.push(item); else groups.push([item]);
  }
  return groups;
}

const titleCase = (t) => String(t ?? '').trim().replace(/^./, (c) => c.toUpperCase());

// One product from the posts that show it: the newest stated price, every stated size and color, pre-order only
// if the newest post says so, and the best-performing post as its picture.
function productFrom(group) {
  const newest = [...group].sort((a, b) => b.created_time.localeCompare(a.created_time));
  const best = [...group].sort((a, b) => (a.boosted - b.boosted) || b.engagement - a.engagement)[0];
  const union = (key, cap) => [...new Set(newest.flatMap((m) => m[key]))].slice(0, cap);
  return {
    name: best.name || titleCase(best.phrase) || titleCase(best.type), product_phrase: best.phrase, product_type: best.type,
    price: newest.find((m) => m.price != null)?.price ?? null, sizes: union('sizes', 12), colors: union('colors', 8),
    status: newest[0].pre_order ? 'pre_order' : 'in_stock', source_post_id: best.id, posts: group.map((m) => m.id),
    items: group,
  };
}

// ---- the extraction stage ----------------------------------------------------------------------------
// Reads the newest tagged posts that are not in the catalog yet, extracts facts (muse-spark-open on Baseten),
// merges posts that show the same product, and either adds them to a product that already exists or creates one.
// Nothing an owner edited is ever overwritten: existing products only gain linked posts. `all` is ignored on
// purpose for the same reason. dryRun returns what would be written without writing it.
export async function extractCatalog(pageId, { progress, dryRun = false } = {}) {
  const tagRows = await fetchAll(() => db.from('post_tags')
    .select('post_id, product_type, product_phrase, posts!inner(id, page_id, message, created_time, engagement_score, is_boosted)')
    .eq('posts.page_id', pageId).order('post_id'));
  const window = tagRows.filter((t) => t.product_type && t.product_type.toLowerCase() !== 'none')
    .sort((a, b) => b.posts.created_time.localeCompare(a.posts.created_time)).slice(0, POST_LIMIT);

  const links = await fetchAll(() => db.from('product_posts').select('post_id, products!inner(page_id)').eq('products.page_id', pageId).order('post_id'));
  const linked = new Set(links.map((l) => l.post_id));
  const todo = window.filter((t) => !linked.has(t.post_id)).map((t) => ({
    id: t.post_id, type: t.product_type.trim().toLowerCase(), phrase: t.product_phrase || '', caption: t.posts.message || '',
    created_time: t.posts.created_time, engagement: Number(t.posts.engagement_score), boosted: t.posts.is_boosted ? 1 : 0,
  }));
  await progress?.(0, todo.length);
  if (!todo.length) return { created: 0, attached: 0, merged: [], failed: 0, total: 0, products: [] };

  let failed = 0;
  const facts = new Map();
  for (const [i, batch] of chunks(todo, BATCH).entries()) {
    try { for (const [id, f] of await extractFacts(batch)) facts.set(id, f); }
    catch (e) { failed += batch.length; console.error('catalog extraction batch failed:', e.status ?? '', JSON.stringify(e.error ?? e.message)); }
    await progress?.(Math.min((i + 1) * BATCH, todo.length), todo.length);
  }
  const items = todo.filter((t) => facts.has(t.id)).map((t) => {
    const f = facts.get(t.id);
    return { ...t, name: f.name, price: f.price, sizes: f.sizes, colors: f.colors, pre_order: f.pre_order, words: captionWords(t.caption), identity: identityTokens(t.phrase, t.type), full: fullTokens(t.phrase) };
  });
  if (!items.length && failed === todo.length) throw new Error(`catalog: all ${failed} posts failed. Check the server log for the cause.`);

  const groups = cluster(items);
  const proposed = groups.map(productFrom);
  const merged = proposed.filter((p) => p.posts.length > 1).sort((a, b) => b.posts.length - a.posts.length);

  // Posts of a product that is already in the catalog join it instead of making a duplicate.
  const existing = await existingProducts(pageId);
  const attach = new Map(); // existing product id -> posts to link
  const fresh = [];
  for (const p of proposed) {
    const rep = { type: p.product_type, price: p.price, words: new Set(), identity: identityTokens(p.product_phrase, p.product_type), full: fullTokens(p.product_phrase) };
    const home = existing.find((e) => sameProduct(rep, e));
    if (home) attach.set(home.id, [...(attach.get(home.id) ?? []), ...p.posts]);
    else fresh.push(p);
  }
  const summary = { created: fresh.length, attached: [...attach.values()].reduce((n, l) => n + l.length, 0), merged, failed, total: todo.length, products: fresh, ...(dryRun && { debug: { todo, facts: [...facts] } }) };
  if (dryRun) return summary;

  const cols = await optionalColumns();
  for (const batch of chunks(fresh, 100)) {
    const rows = batch.map((p) => ({
      page_id: pageId, name: p.name, product_type: p.product_type, price: p.price, sizes: p.sizes, colors: p.colors, status: p.status, source_post_id: p.source_post_id,
      ...(cols.product_phrase && { product_phrase: p.product_phrase }), ...(cols.source && { source: 'extracted' }),
    }));
    const { data, error } = await db.from('products').insert(rows).select('id');
    if (error) throw new Error(`products: ${error.message}`);
    const linksOut = batch.flatMap((p, i) => p.posts.map((post_id) => ({ product_id: data[i].id, post_id })));
    for (const part of chunks(linksOut, 500)) {
      const { error: err } = await db.from('product_posts').upsert(part);
      if (err) throw new Error(`product_posts: ${err.message}`);
    }
  }
  for (const [productId, postIds] of attach) {
    const { error } = await db.from('product_posts').upsert(postIds.map((post_id) => ({ product_id: productId, post_id })));
    if (error) throw new Error(`product_posts: ${error.message}`);
  }
  return summary;
}

async function existingProducts(pageId) {
  const cols = await optionalColumns();
  const rows = await fetchAll(() => db.from('products').select(`id, name, product_type, price${cols.product_phrase ? ', product_phrase' : ''}`).eq('page_id', pageId).order('id'));
  return rows.filter((r) => r.product_type).map((r) => ({
    id: r.id, type: r.product_type.toLowerCase(), price: r.price == null ? null : Number(r.price), words: new Set(), identity: identityTokens(r.product_phrase || r.name, r.product_type), full: fullTokens(r.product_phrase || r.name),
  }));
}

// Are there tagged posts in the newest window that no product covers yet?
export async function hasUncataloguedPosts(pageId) {
  const tagRows = await fetchAll(() => db.from('post_tags')
    .select('post_id, product_type, posts!inner(page_id, created_time)').eq('posts.page_id', pageId).order('post_id'));
  const window = tagRows.filter((t) => t.product_type && t.product_type.toLowerCase() !== 'none')
    .sort((a, b) => b.posts.created_time.localeCompare(a.posts.created_time)).slice(0, POST_LIMIT);
  if (!window.length) return false;
  const links = await fetchAll(() => db.from('product_posts').select('post_id, products!inner(page_id)').eq('products.page_id', pageId).order('post_id'));
  const linked = new Set(links.map((l) => l.post_id));
  return window.some((t) => !linked.has(t.post_id));
}

// ---- reading and changing the catalog ---------------------------------------------------------------
const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);

// One row for the screen. Extracted products show the photo of their best linked post; uploaded ones their own.
async function view(row, postsOf, cols) {
  const linked = postsOf.get(row.id) ?? [];
  const best = [...linked].sort((a, b) => (a.is_boosted - b.is_boosted) || b.engagement_score - a.engagement_score).find((p) => p.photo_url);
  const source = row.source ?? (row.source_post_id ? 'extracted' : 'uploaded');
  const photo = row.photo_url?.startsWith('storage://') ? row.photo_url : best?.photo_url ?? row.photo_url ?? null;
  return {
    id: row.id, name: row.name, type: row.product_type, phrase: row.product_phrase ?? null, price: row.price == null ? null : Number(row.price),
    sizes: row.sizes ?? [], colors: row.colors ?? [], offer: cols.offer ? row.offer ?? null : null, stock: cols.stock ? row.stock ?? null : null,
    status: row.status, source, posts: linked.length, thumbnail_url: await showableUrl(photo), photo_ref: row.photo_url?.startsWith('storage://') ? row.photo_url : null,
    source_post_id: row.source_post_id ?? null, missing_price: row.price == null, updated_at: row.updated_at,
  };
}

async function loadPosts(productIds) {
  const postsOf = new Map();
  for (const ids of chunks(productIds, 150)) {
    const links = await fetchAll(() => db.from('product_posts').select('product_id, posts!inner(id, message, photo_url, engagement_score, is_boosted, created_time)').in('product_id', ids).order('post_id'));
    for (const l of links) { if (!postsOf.has(l.product_id)) postsOf.set(l.product_id, []); postsOf.get(l.product_id).push({ ...l.posts, is_boosted: l.posts.is_boosted ? 1 : 0 }); }
  }
  return postsOf;
}

const selectCols = (cols) => `id, page_id, name, product_type, price, sizes, colors, photo_url, source_post_id, status, updated_at${cols.product_phrase ? ', product_phrase' : ''}${cols.offer ? ', offer' : ''}${cols.stock ? ', stock' : ''}${cols.source ? ', source' : ''}`;

export async function listCatalog(pageId, { q = '', status = '' } = {}) {
  const cols = await optionalColumns();
  const rows = await fetchAll(() => db.from('products').select(selectCols(cols)).eq('page_id', pageId).order('id'));
  const postsOf = await loadPosts(rows.map((r) => r.id));
  let products = await Promise.all(rows.map((r) => view(r, postsOf, cols)));
  const all = products;
  const needle = String(q).toLowerCase().trim();
  if (needle) products = products.filter((p) => [p.name, p.type, p.phrase, ...p.colors, ...p.sizes].join(' ').toLowerCase().includes(needle));
  if (STATUSES.includes(status)) products = products.filter((p) => p.status === status);
  const rank = { in_stock: 0, pre_order: 1, sold_out: 2 };
  products.sort((a, b) => rank[a.status] - rank[b.status] || b.posts - a.posts || a.name.localeCompare(b.name));
  return {
    products,
    capabilities: { offer: cols.offer, stock: cols.stock, phrase: cols.product_phrase }, // what the database can keep until migration 006
    summary: {
      total: all.length, missing_price: all.filter((p) => p.missing_price).length,
      in_stock: all.filter((p) => p.status === 'in_stock').length, pre_order: all.filter((p) => p.status === 'pre_order').length, sold_out: all.filter((p) => p.status === 'sold_out').length,
    },
  };
}

export async function getProduct(pageId, id) {
  const cols = await optionalColumns();
  const { data: row, error } = await db.from('products').select(selectCols(cols)).eq('id', id).eq('page_id', pageId).maybeSingle();
  if (error) throw error;
  if (!row) throw fail('Product not found.', 404);
  const postsOf = await loadPosts([id]);
  const posts = (postsOf.get(id) ?? []).sort((a, b) => b.created_time.localeCompare(a.created_time));
  return {
    ...(await view(row, postsOf, cols)),
    linked_posts: await Promise.all(posts.map(async (p) => ({ id: p.id, caption: p.message ?? '', photo_url: await showableUrl(p.photo_url), engagement_score: Number(p.engagement_score), created_time: p.created_time }))),
  };
}

export async function updateProduct(pageId, id, body) {
  const cols = await optionalColumns();
  const patch = {};
  if ('name' in body) {
    const name = clip(String(body.name ?? '').trim(), 120);
    if (!name) throw fail('A product needs a name.');
    patch.name = name;
  }
  if ('type' in body) patch.product_type = clip(String(body.type ?? '').trim().toLowerCase(), 40) || null;
  if ('price' in body) {
    const raw = body.price;
    if (raw === null || raw === '') patch.price = null;
    else {
      const n = Number(String(raw).replace(/[,\s৳]|tk\.?|taka/gi, ''));
      if (!Number.isFinite(n) || n < 0) throw fail('The price must be a number, for example 950.');
      patch.price = n;
    }
  }
  if ('sizes' in body) patch.sizes = toList(body.sizes);
  if ('colors' in body) patch.colors = toList(body.colors).map((c) => c.toLowerCase());
  if ('phrase' in body && cols.product_phrase) patch.product_phrase = clip(String(body.phrase ?? '').trim(), 160) || null;
  if ('offer' in body && cols.offer) patch.offer = clip(String(body.offer ?? '').trim(), 100) || null;
  if ('stock' in body && cols.stock) {
    if (body.stock === null || body.stock === '') patch.stock = null;
    else { const n = Math.floor(Number(body.stock)); if (!Number.isFinite(n) || n < 0) throw fail('Stock must be a number, or empty.'); patch.stock = n; }
  }
  if (!Object.keys(patch).length) throw fail('Nothing to change.');
  const { data, error } = await db.from('products').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('page_id', pageId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw fail('Product not found.', 404);
  return getProduct(pageId, id);
}

export async function setStatus(pageId, id, status) {
  if (!STATUSES.includes(status)) throw fail(`status must be one of ${STATUSES.join(', ')}`);
  const { data, error } = await db.from('products').update({ status, updated_at: new Date().toISOString() }).eq('id', id).eq('page_id', pageId).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw fail('Product not found.', 404);
  return getProduct(pageId, id);
}

// Folds `mergeId` into `keepId`: its posts and drafts move over, empty fields are filled from it, sizes and colors
// are combined, and the duplicate is removed.
export async function mergeProducts(pageId, keepId, mergeId) {
  if (!keepId || !mergeId || keepId === mergeId) throw fail('Pick two different products to merge.');
  const keep = await getProduct(pageId, keepId);
  const gone = await getProduct(pageId, mergeId);
  const cols = await optionalColumns();
  const patch = {
    price: keep.price ?? gone.price, sizes: [...new Set([...keep.sizes, ...gone.sizes])].slice(0, 12), colors: [...new Set([...keep.colors, ...gone.colors])].slice(0, 8),
    ...(cols.product_phrase && { product_phrase: keep.phrase ?? gone.phrase }), ...(cols.offer && { offer: keep.offer ?? gone.offer }), ...(cols.stock && { stock: keep.stock ?? gone.stock }),
    updated_at: new Date().toISOString(),
  };
  const { error: e1 } = await db.from('products').update(patch).eq('id', keepId);
  if (e1) throw e1;
  if (gone.linked_posts.length) {
    const { error } = await db.from('product_posts').upsert(gone.linked_posts.map((p) => ({ product_id: keepId, post_id: p.id })));
    if (error) throw error;
  }
  if (await hasColumns('post_drafts', ['product_id'])) await db.from('post_drafts').update({ product_id: keepId }).eq('product_id', mergeId);
  const { error: e2 } = await db.from('products').delete().eq('id', mergeId).eq('page_id', pageId); // product_posts rows of the old product go with it
  if (e2) throw e2;
  return getProduct(pageId, keepId);
}

// An in-stock product of the same kind to point customers to when something is sold out.
export async function similarInStock(pageId, product) {
  const { products } = await listCatalog(pageId);
  const mine = identityTokens(product.phrase || product.name, product.type);
  return products
    .filter((p) => p.id !== product.id && p.type === product.type && p.status !== 'sold_out')
    .map((p) => ({ p, score: jaccard(mine, identityTokens(p.phrase || p.name, p.type)) }))
    .sort((a, b) => b.score - a.score || b.p.posts - a.p.posts)[0]?.p ?? null;
}
