import { Router } from 'express';
import { db } from '../db.js';
import { exchangeLongLivedToken, listUserPages } from '../facebook.js';

const router = Router();

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err.message);
    res.status(err.status || 500).json({ error: err.message });
  });

// Step 1: user token in, list of pages out. Nothing stored, no page tokens returned.
router.post('/facebook', wrap(async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken is required' });
  const userToken = await exchangeLongLivedToken(accessToken);
  const pages = await listUserPages(userToken);
  res.json({ pages: pages.map(({ id, name }) => ({ id, name })) });
}));

// Step 2: store the chosen page with its page token.
router.post('/select-page', wrap(async (req, res) => {
  const { accessToken, pageId } = req.body;
  if (!accessToken || !pageId) {
    return res.status(400).json({ error: 'accessToken and pageId are required' });
  }
  const userToken = await exchangeLongLivedToken(accessToken);
  const page = (await listUserPages(userToken)).find((p) => p.id === pageId);
  if (!page) return res.status(403).json({ error: 'You do not manage that page' });

  const { error } = await db.from('pages').upsert({
    id: page.id,
    name: page.name,
    access_token: page.access_token,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  res.json({ page: { id: page.id, name: page.name } });
}));

export default router;
