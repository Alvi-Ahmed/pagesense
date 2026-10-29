import { Router } from 'express';
import { listUserPages } from '../facebook.js';
import { startSync, getSyncStatus } from '../sync.js';
import { startTagging, getTagStatus } from '../tag.js';
import { DEMO_PAGE_ID } from '../demo.js';
import { db } from '../db.js';
import { startAnalysis, latestAnalysis } from '../analysis.js';
import { latestPlaybook, previewPlaybook, setBoosted } from '../playbook.js';
import { needsReply } from '../replies.js';

const router = Router();

// Caller proves they manage the page with their Facebook user token.
const requireManager = async (req, res, next) => {
  // Demo page: a seeded snapshot with no Facebook token, so there is nothing to protect or to call.
  if (req.params.id === DEMO_PAGE_ID) return next();
  try {
    const { accessToken } = req.body;
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

// Analysis runs automatically after a sync; POST is the Retry button.
// Demo: nothing to rerun (and nothing may be written), so Retry just returns the latest job.
router.post('/:id/analysis', requireManager, handle((req) =>
  (req.params.id === DEMO_PAGE_ID ? latestAnalysis(req.params.id) : startAnalysis(req.params.id))));
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
