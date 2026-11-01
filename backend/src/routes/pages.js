import express, { Router } from 'express';
import { listUserPages } from '../facebook.js';
import { startSync, getSyncStatus } from '../sync.js';
import { startTagging, getTagStatus } from '../tag.js';
import { DEMO_PAGE_ID } from '../demo.js';
import { db } from '../db.js';
import { startAnalysis, latestAnalysis } from '../analysis.js';
import { angleInsight, latestPlaybook, previewPlaybook, setBoosted } from '../playbook.js';
import { needsReply } from '../replies.js';
import { hasAuthorColumns, hasColumns } from '../schema.js';
import { generateFromCatalog, generateNewProduct, generatePost, improvePost, listDrafts, listProducts, saveDraft, updateDraft } from '../generate.js';
import { analyzePhotos, saveNewProduct } from '../newProduct.js';
import { getProduct, listCatalog, mergeProducts, setStatus, updateProduct } from '../catalog.js';
import { savedUpdates, suggestUpdates } from '../catalogUpdates.js';
import { convertToOrder, exportConfirmed, listOrders, setOrderStatus, suggestReply, updateOrder } from '../orders.js';
import { MAX_BYTES as MAX_SHEET, applyImport, excelBuffer, exportStock, getVariants, previewImport, setLowStockThreshold, setVariants, stockAlerts } from '../stock.js';
import { cleanPhoto, loadStored, refFor, showableUrl, storePhoto, MAX_BYTES } from '../photos.js';
import { MAX_LOGO_BYTES, brandView, generateLogos, loadLogo, logoFromDataUrl, logoFromUpload, putFile, saveBrand, saveLogo, signedUrl } from '../brand.js';
import { detectProduct, productPhrase, renderBranded } from '../branding.js';
import { rateLimit } from '../rateLimit.js';
import { isSessionToken, verifySession } from '../session.js';

const router = Router();

// Caller proves they manage the page with their Facebook user token.
const requireManager = async (req, res, next) => {
  // Demo page: a seeded snapshot with no Facebook token, so there is nothing to protect or to call.
  if (req.params.id === DEMO_PAGE_ID) return next();
  try {
    const accessToken = req.body?.accessToken || req.get('x-access-token'); // uploads are raw images, so the token comes in a header
    if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });
    if (isSessionToken(accessToken)) { // our own signed page session: checked here, no call to Facebook
      if (verifySession(accessToken) !== req.params.id) return res.status(403).json({ error: 'You do not manage that page' });
      return next();
    }
    const pages = await listUserPages(accessToken); // a Facebook login token, as older sessions still send
    if (!pages.some((p) => p.id === req.params.id)) {
      return res.status(403).json({ error: 'You do not manage that page' });
    }
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, ...(err.code && { code: err.code }) });
  }
};

// The demo page is shared and read-only: nothing a visitor does may write to the database.
const rejectDemoWrites = (req, res, next) =>
  req.params.id === DEMO_PAGE_ID ? res.status(400).json({ error: 'The demo page is read-only' }) : next();

const handle = (fn) => async (req, res) => {
  try {
    res.status(202).json(await fn(req));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};

router.post('/:id/sync', requireManager, handle((req) => {
  const days = Number(req.body.days) || 0
  if (days < 0 || days > 3650) throw Object.assign(new Error('days must be between 1 and 3650'), { status: 400 })
  return startSync(req.params.id, Math.floor(days))
}));
router.get('/:id/sync', (req, res) => res.json(getSyncStatus(req.params.id)));

// Optional body.limit tags only the first N untagged posts (handy for a cheap trial run).
router.post('/:id/tag', rejectDemoWrites, requireManager, handle((req) => startTagging(req.params.id, Number(req.body.limit) || 0)));
router.get('/:id/tag', (req, res) => res.json(getTagStatus(req.params.id)));

// Analysis runs automatically after a sync, on startup and when a page is opened: POST runs whichever stages
// are missing or out of date (it is also the Retry button). { force: true } is Re-analyse: every stage, every item.
// Demo: nothing to rerun (and nothing may be written), so startAnalysis just returns the latest job.
router.post('/:id/analysis', requireManager, handle((req) =>
  startAnalysis(req.params.id, { force: req.body.force === true })));
router.get('/:id/analysis', async (req, res) => {
  try {
    res.json(await latestAnalysis(req.params.id));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cached playbook from the last analysis run: { status: 'none' } until one has finished.
router.get('/:id/playbook', async (req, res) => {
  try {
    const pb = await latestPlaybook(req.params.id);
    res.json(pb.status === 'ready' && req.params.id !== DEMO_PAGE_ID ? { ...pb, angles: await angleInsight(req.params.id) } : pb);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// "Was this boosted?" toggle: boosted posts are excluded from the playbook, which is rebuilt before this returns.
router.post('/:id/posts/:postId/boosted', rejectDemoWrites, requireManager, async (req, res) => {
  try {
    if (typeof req.body.boosted !== 'boolean') return res.status(400).json({ error: 'boosted must be true or false' });
    res.json(await setBoosted(req.params.id, req.params.postId, req.body.boosted));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Demo only: the playbook as it would look with the visitor's own boosted flags (kept in their browser).
// Computed in memory; nothing is saved.
router.post('/:id/playbook/preview', async (req, res) => {
  try {
    if (req.params.id !== DEMO_PAGE_ID) return res.status(400).json({ error: 'Preview is only for the demo page' });
    res.json(await previewPlaybook(req.params.id, req.body.boosted));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- post generation (items 9 and 16) ----------------------------------------------------------
// Generation spends model credits, so it is rate limited: the public demo per visitor, a real page per page.
const GENERATIONS_PER_HOUR = { demo: 20, page: 60 };
const generationLimit = rateLimit(
  (req) => (req.params.id === DEMO_PAGE_ID ? `demo:${req.ip}` : `page:${req.params.id}`),
  (req) => (req.params.id === DEMO_PAGE_ID ? GENERATIONS_PER_HOUR.demo : GENERATIONS_PER_HOUR.page),
);

// Real pages keep their drafts in post_drafts. The demo is read-only: its drafts live in the visitor's browser.
const respondWithDraft = async (req, res, make) => {
  try {
    const result = await make();
    const draft = req.params.id === DEMO_PAGE_ID ? null : await saveDraft(req.params.id, result);
    res.json({ ...result, draft_id: draft?.id ?? null });
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};

router.get('/:id/posts/products', async (req, res) => {
  try {
    res.json({ products: await listProducts(req.params.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/posts/generate', requireManager, generationLimit, async (req, res) => {
  // A new product is only saved (product and draft together) when the owner presses Save, so nothing is stored here.
  if (req.body.productId) return respondWithDraft(req, res, () => generateFromCatalog(req.params.id, req.body));
  if (!req.body.newProduct) return respondWithDraft(req, res, () => generatePost(req.params.id, req.body));
  try {
    res.json(await generateNewProduct(req.params.id, { ...req.body.newProduct, language: req.body.language }));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- new product from photos --------------------------------------------------------------------------
// Real pages: photos are cleaned (EXIF and location removed) and kept in Supabase Storage. The demo never stores
// anything: its photos stay in the visitor's browser and are sent along (as base64) only to be analysed.
const uploadLimit = rateLimit((req) => `upload:${req.params.id}`, () => 60);
router.post('/:id/uploads', rejectDemoWrites, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_BYTES }),
  requireManager, uploadLimit, async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send one JPEG, PNG or WebP photo per request.' });
      const { full, width, height } = await cleanPhoto(req.body);
      const { id, path } = await storePhoto(req.params.id, full);
      res.json({ id, url: await showableUrl(refFor(path)), width, height });
    } catch (err) {
      console.error(err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

router.post('/:id/products/analyze', requireManager, generationLimit, async (req, res) => {
  try {
    res.json(await analyzePhotos(req.params.id, req.body.images, { demo: req.params.id === DEMO_PAGE_ID }));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:id/products', rejectDemoWrites, requireManager, async (req, res) => {
  try {
    const { product, draft, columns_missing: legacy } = await saveNewProduct(req.params.id, req.body);
    res.json({ product, draft: { ...draft, photo_url: await showableUrl(draft.photo_url) }, migration_005_pending: legacy });
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/:id/posts/improve', requireManager, generationLimit, (req, res) =>
  respondWithDraft(req, res, () => improvePost(req.params.id, req.body)));

router.get('/:id/drafts', async (req, res) => {
  try {
    res.json({ drafts: req.params.id === DEMO_PAGE_ID ? [] : await listDrafts(req.params.id) });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/drafts/:draftId', rejectDemoWrites, requireManager, async (req, res) => {
  try {
    res.json(await updateDraft(req.params.id, req.params.draftId, req.body.caption, req.body.variant));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- catalog (items 6, 8, 18) ----------------------------------------------------------------------
// The demo catalog is read-only: edits, status changes and merges happen in the visitor's browser (never here).
const reply = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};

router.get('/:id/catalog', reply((req) => listCatalog(req.params.id, { q: req.query.q, status: req.query.status })));
router.get('/:id/catalog/:productId', reply(async (req) => ({ ...(await getProduct(req.params.id, req.params.productId)), variants: await getVariants(req.params.id, req.params.productId) })));
router.patch('/:id/catalog/:productId', rejectDemoWrites, requireManager, reply((req) => updateProduct(req.params.id, req.params.productId, req.body)));
router.post('/:id/catalog/:productId/status', rejectDemoWrites, requireManager, reply((req) => setStatus(req.params.id, req.params.productId, req.body.status)));
router.post('/:id/catalog/merge', rejectDemoWrites, requireManager, reply((req) => mergeProducts(req.params.id, req.body.keepId, req.body.mergeId)));

// Suggested caption updates for a sold-out product's posts (or "back in stock" after a restock). They spend model
// credits, so they share the generation limit. Real pages save them; the demo only returns them.
router.post('/:id/catalog/:productId/updates', requireManager, generationLimit, reply((req) =>
  suggestUpdates(req.params.id, req.params.productId, { ...req.body, save: req.params.id !== DEMO_PAGE_ID, trustKind: req.params.id === DEMO_PAGE_ID })));
router.get('/:id/catalog/:productId/updates', reply((req) => savedUpdates(req.params.id, req.params.productId, req.query.kind === 'restock' ? 'restock' : 'sold_out')));

// ---- orders (items 7 and 17) ----------------------------------------------------------------------
// Orders hold what customers wrote, phone numbers included, so a real page proves who is asking on every call
// (token in the x-access-token header for reads). The demo is read-only: status changes and edits stay in the
// visitor's browser. Suggested replies are allowed everywhere and share the generation limit.
router.get('/:id/orders', requireManager, reply((req) => listOrders(req.params.id, req.query.status)));
router.get('/:id/orders/export', requireManager, async (req, res) => {
  try {
    const csv = await exportConfirmed(req.params.id);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-confirmed-${new Date().toISOString().slice(0, 10)}.csv"` }).send(`\uFEFF${csv}`);
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});
router.patch('/:id/orders/:orderId', rejectDemoWrites, requireManager, reply((req) => updateOrder(req.params.id, req.params.orderId, req.body)));
router.post('/:id/orders/:orderId/status', rejectDemoWrites, requireManager, reply((req) => setOrderStatus(req.params.id, req.params.orderId, req.body.status)));
router.post('/:id/orders/:orderId/convert', rejectDemoWrites, requireManager, reply((req) => convertToOrder(req.params.id, req.params.orderId)));
router.post('/:id/orders/:orderId/reply', requireManager, generationLimit, reply((req) => suggestReply(req.params.id, req.params.orderId)));

// ---- stock from the owner's spreadsheet (item 21) -------------------------------------------------------------
// Preview only reads and matches (it may call the model, so it shares the generation limit); nothing is saved until
// the owner confirms. The demo can preview and download, but never writes: its confirmed import stays in the browser.
router.post('/:id/stock/preview', requireManager, generationLimit, reply(async (req) => {
  const { file, sheet, mapping } = req.body;
  if (typeof file !== 'string' || !file) throw Object.assign(new Error('Choose an Excel or CSV file first.'), { status: 400 });
  if (file.length > Math.ceil(MAX_SHEET * 1.4)) throw Object.assign(new Error('The file must be 5 MB or smaller.'), { status: 400 });
  return previewImport(req.params.id, { buffer: Buffer.from(file, 'base64'), sheet, mapping });
}));
router.post('/:id/stock/import', rejectDemoWrites, requireManager, reply((req) => applyImport(req.params.id, req.body)));
router.put('/:id/catalog/:productId/stock', rejectDemoWrites, requireManager, reply((req) => setVariants(req.params.id, req.params.productId, req.body.variants ?? [])));
router.get('/:id/stock/alerts', reply((req) => stockAlerts(req.params.id)));
router.patch('/:id/settings', rejectDemoWrites, requireManager, reply((req) => setLowStockThreshold(req.params.id, req.body.low_stock_threshold)));
router.get('/:id/stock/export', requireManager, async (req, res) => {
  try {
    const { buffer } = await exportStock(req.params.id);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="stock-${new Date().toISOString().slice(0, 10)}.xlsx"` }).send(buffer);
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});
// The demo keeps its stock in the visitor's browser, so it sends its rows and gets a workbook back (nothing is stored).
router.post('/:id/stock/xlsx', async (req, res) => {
  try {
    if (req.params.id !== DEMO_PAGE_ID) return res.status(400).json({ error: 'Use the stock download for your page.' });
    const lines = Array.isArray(req.body.lines) ? req.body.lines.slice(0, 5000).map((l) => ({ name: String(l.name ?? '').slice(0, 120), size: String(l.size ?? '').slice(0, 20), color: String(l.color ?? '').slice(0, 30), quantity: Number.isFinite(Number(l.quantity)) ? Number(l.quantity) : '', price: Number.isFinite(Number(l.price)) ? Number(l.price) : '', sku: String(l.sku ?? '').slice(0, 40) })) : [];
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="stock.xlsx"' }).send(excelBuffer(req.body.layout, lines));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- brand and photo branding (item 10) --------------------------------------------------------------------------
// Real pages keep their brand and branded photos in Supabase Storage. The demo keeps everything in the visitor's tab:
// its logo and settings come along with each request (a PNG data URL) and nothing is stored.
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
const renderLimit = rateLimit((req) => `render:${req.params.id}:${req.ip}`, () => 400);

// The photo to brand: one the owner just uploaded, one sent along by the demo, or a post of this page.
async function sourcePhoto(pageId, source = {}) {
  if (source.upload_id) return loadStored(pageId, source.upload_id);
  if (source.data) {
    if (pageId !== DEMO_PAGE_ID) throw Object.assign(new Error('Upload the photo first.'), { status: 400 });
    const m = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/.exec(String(source.data));
    if (!m) throw Object.assign(new Error('That photo is not a JPEG, PNG or WebP image.'), { status: 400 });
    return (await cleanPhoto(Buffer.from(m[1], 'base64'))).full;
  }
  if (source.post_id) {
    const { data } = await db.from('posts').select('photo_url').eq('id', source.post_id).eq('page_id', pageId).maybeSingle();
    if (!data?.photo_url) throw Object.assign(new Error('That post has no photo.'), { status: 404 });
    const res = await fetch(data.photo_url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error('The post photo could not be loaded.'), { status: 502 });
    return (await cleanPhoto(Buffer.from(await res.arrayBuffer()))).full;
  }
  throw Object.assign(new Error('Choose a photo to brand.'), { status: 400 });
}

router.get('/:id/brand', requireManager, reply((req) => (req.params.id === DEMO_PAGE_ID ? { shop_name: 'Demo Shop', color: '#12694A', has_logo: false, demo: true } : brandView(req.params.id))));
router.put('/:id/brand', rejectDemoWrites, requireManager, reply((req) => saveBrand(req.params.id, req.body)));

// A logo file (PNG or SVG) cleaned into a transparent PNG and sent back to look at. Nothing is stored here.
router.post('/:id/brand/logo/process', express.raw({ type: ['image/png', 'image/svg+xml'], limit: MAX_LOGO_BYTES }), requireManager, uploadLimit, reply(async (req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error('Send one PNG or SVG file.'), { status: 400 });
  return { image: dataUrl(await logoFromUpload(req.body, req.get('content-type') ?? '')) };
}));
router.post('/:id/brand/logo/generate', requireManager, generationLimit, reply(async (req) => {
  const brand = req.params.id === DEMO_PAGE_ID ? {} : await brandView(req.params.id);
  const options = await generateLogos({ shopName: req.body.shop_name ?? brand.shop_name, style: req.body.style, color: req.body.color ?? brand.color });
  return { options: options.map((o) => ({ id: o.id, image: dataUrl(o.png), verified: o.verified, read: o.read })) };
}));
router.post('/:id/brand/logo/save', rejectDemoWrites, requireManager, reply(async (req) => saveLogo(req.params.id, await logoFromDataUrl(req.body.image))));

router.post('/:id/branding/detect', requireManager, generationLimit, reply(async (req) => {
  const photo = await sourcePhoto(req.params.id, req.body.source);
  const named = await productPhrase(photo, req.body.hint);
  const found = await detectProduct(photo, named);
  return { ...found, phrase: named.phrase, worn: named.worn };
}));

const renderFrom = async (req, { demo }) => {
  const { boxes, options, price, offer } = req.body;
  const photo = await sourcePhoto(req.params.id, req.body.source);
  const safeBoxes = (Array.isArray(boxes) ? boxes : []).slice(0, 12).map((b) => ({ x1: +b.x1, y1: +b.y1, x2: +b.x2, y2: +b.y2 }))
    .filter((b) => [b.x1, b.y1, b.x2, b.y2].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && b.x2 > b.x1 && b.y2 > b.y1);
  const brand = demo ? { color: req.body.color } : await brandView(req.params.id);
  const logo = demo ? (req.body.logo ? await logoFromDataUrl(req.body.logo) : null) : await loadLogo(req.params.id);
  const color = /^#[0-9a-f]{6}$/i.test(brand.color ?? '') ? brand.color : '#12694A';
  const priceNum = Number(price);
  return renderBranded({
    photo, boxes: safeBoxes, logo, color, price: Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null, offer: offer ? String(offer).slice(0, 40) : null,
    options: { logo: options?.logo !== false, badge: options?.badge !== false, format: options?.format === 'portrait' ? 'portrait' : 'square', region: Math.floor(Number(options?.region)) || 0, padding: options?.padding === 'brand' ? 'brand' : 'blur' },
  });
};
const summary = ({ buffer, blocked, ...info }) => ({ image: dataUrl(buffer, 'image/jpeg'), ...info, blocked: undefined });

router.post('/:id/branding/render', requireManager, renderLimit, reply(async (req) => summary(await renderFrom(req, { demo: req.params.id === DEMO_PAGE_ID }))));

// Keeps the branded image with a draft (real pages only): rendered again here from the settings, stored in Storage.
router.post('/:id/drafts/:draftId/branded', rejectDemoWrites, requireManager, renderLimit, reply(async (req) => {
  if (!(await hasColumns('post_drafts', ['branded_url', 'branding']))) throw Object.assign(new Error('Saving branded photos needs db/009_brand.sql to be run first.'), { status: 409 });
  const out = await renderFrom(req, { demo: false });
  const ref = await putFile(req.params.id, `branded/${req.params.draftId}-${Date.now()}.jpg`, out.buffer, 'image/jpeg');
  const { data, error } = await db.from('post_drafts').update({ branded_url: ref, branding: { options: req.body.options ?? {}, logo: out.logo, badge: out.badge, notes: out.notes } })
    .eq('id', req.params.draftId).eq('page_id', req.params.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Draft not found.'), { status: 404 });
  return { branded_url: await signedUrl(ref), notes: out.notes };
}));

// Comments that need an answer, for Home.
router.get('/:id/replies', async (req, res) => {
  try {
    res.json(await needsReply(req.params.id, { intent: req.query.intent, limit: req.query.limit }));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// Counts for the app header and Home tiles. Read-only, so no login check (same as the status endpoints).
router.get('/:id/summary', async (req, res) => {
  try {
    const id = req.params.id;
    const count = async (query) => {
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    };
    const head = { count: 'exact', head: true };
    // The tiles link to lists of comments that still need the owner, so they count the same ones: not written by the
    // page itself and not answered yet (once the sync has recorded authors).
    const open = await hasAuthorColumns();
    const waiting = (intent) => {
      const q = db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id).eq('intent', intent);
      return open ? q.eq('is_page', false).eq('answered', false) : q;
    };
    const [posts, comments, tagged, classified, order, price, complaint, page] = await Promise.all([
      count(db.from('posts').select('*', head).eq('page_id', id)),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id)),
      count(db.from('post_tags').select('*, posts!inner(page_id)', head).eq('posts.page_id', id)),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id).not('intent', 'is', null)),
      count(waiting('order_intent')),
      count(waiting('price_question')),
      count(waiting('complaint')),
      db.from('pages').select('id, name').eq('id', id).maybeSingle(),
    ]);
    if (!page.data) return res.status(404).json({ error: 'Page not connected' });
    res.json({
      page: page.data, posts, comments, tagged, classified,
      intents: { order_intent: order, price_question: price, complaint },
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
