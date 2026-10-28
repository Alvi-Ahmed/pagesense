import { Router } from 'express';
import { listUserPages } from '../facebook.js';
import { startSync, getSyncStatus } from '../sync.js';
import { startTagging, getTagStatus } from '../tag.js';

const router = Router();

// Caller proves they manage the page with their Facebook user token.
const requireManager = async (req, res, next) => {
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

const handle = (fn) => async (req, res) => {
  try {
    res.status(202).json(await fn(req));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
};

router.post('/:id/sync', requireManager, handle((req) => startSync(req.params.id)));
router.get('/:id/sync', (req, res) => res.json(getSyncStatus(req.params.id)));

// Optional body.limit tags only the first N untagged posts (handy for a cheap trial run).
router.post('/:id/tag', requireManager, handle((req) => startTagging(req.params.id, Number(req.body.limit) || 0)));
router.get('/:id/tag', (req, res) => res.json(getTagStatus(req.params.id)));

export default router;
