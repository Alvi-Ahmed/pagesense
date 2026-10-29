import express, { Router } from 'express';
import { listUserPages } from '../facebook.js';
import { startSync, getSyncStatus } from '../sync.js';
import { startTagging, getTagStatus } from '../tag.js';
import { DEMO_PAGE_ID } from '../demo.js';
import { db } from '../db.js';
import { startAnalysis, latestAnalysis } from '../analysis.js';
import { latestPlaybook, previewPlaybook, setBoosted } from '../playbook.js';
import { needsReply } from '../replies.js';
import { generateNewProduct, generatePost, improvePost, listDrafts, listProducts, saveDraft, updateDraft } from '../generate.js';
import { analyzePhotos, saveNewProduct } from '../newProduct.js';
import { cleanPhoto, refFor, showableUrl, storePhoto, MAX_BYTES } from '../photos.js';
import { rateLimit } from '../rateLimit.js';

const router = Router();

// Caller proves they manage the page with their Facebook user token.
const requireManager = async (req, res, next) => {
  // Demo page: a seeded snapshot with no Facebook token, so there is nothing to protect or to call.
  if (req.params.id === DEMO_PAGE_ID) return next();
  try {
    const accessToken = req.body?.accessToken || req.get('x-access-token'); // uploads are raw images, so the token comes in a header
    if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });
    const pages = await listUserPages(accessToken);
    if (!pages.some((p) => p.id === req.params.id)) {
      return res.status(403).json({ error: 'You do not manage that page' });
    }
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
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
    res.json(await latestPlaybook(req.params.id));
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
    res.json(await updateDraft(req.params.id, req.params.draftId, req.body.caption));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Comments that need an answer, for Home.
router.get('/:id/replies', async (req, res) => {
  try {
    res.json(await needsReply(req.params.id));
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
    const [posts, comments, tagged, classified, order, price, complaint, page] = await Promise.all([
      count(db.from('posts').select('*', head).eq('page_id', id)),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id)),
      count(db.from('post_tags').select('*, posts!inner(page_id)', head).eq('posts.page_id', id)),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id).not('intent', 'is', null)),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id).eq('intent', 'order_intent')),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id).eq('intent', 'price_question')),
      count(db.from('comments').select('*, posts!inner(page_id)', head).eq('posts.page_id', id).eq('intent', 'complaint')),
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
