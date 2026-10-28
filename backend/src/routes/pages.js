import { Router } from 'express';
import { listUserPages } from '../facebook.js';
import { startSync, getSyncStatus } from '../sync.js';

const router = Router();

// Starts a sync. The caller proves they manage the page with their Facebook user token.
router.post('/:id/sync', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });
    const pages = await listUserPages(accessToken);
    if (!pages.some((p) => p.id === req.params.id)) {
      return res.status(403).json({ error: 'You do not manage that page' });
    }
    res.status(202).json(await startSync(req.params.id));
  } catch (err) {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Progress for the web app to poll.
router.get('/:id/sync', (req, res) => res.json(getSyncStatus(req.params.id)));

export default router;
