// Snapshot a synced page into demo/snapshot.json with ids anonymised and personal text scrubbed.
// Run: npm run demo:export [-- <pageId>]   (default: the real page with the most posts)
import fs from 'node:fs';
import { db } from '../src/db.js';

const POSTS_RECENT = 120;   // newest photo posts
const POSTS_TOP = 30;       // plus the highest-engagement ones, for pattern variety
const COMMENTS_PER_POST = 40;

// Comments are customer text: remove anything that identifies a person.
const scrub = (text) => text == null ? null : text
  .replace(/https?:\/\/\S+/gi, '[link]')
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\+?[\d০-৯][\d০-৯\s\-().]{6,}[\d০-৯]/g, '[number]')
  .replace(/@\S+/g, '@customer');

const fetchAll = async (build) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
};

let pageId = process.argv[2];
if (!pageId) {
  const { data } = await db.from('pages').select('id').neq('id', 'demo');
  if (!data?.length) throw new Error('No synced page found');
  let best = -1;
  for (const p of data) {
    const { count } = await db.from('posts').select('*', { count: 'exact', head: true }).eq('page_id', p.id);
    if (count > best) { best = count; pageId = p.id; }
  }
}
if (pageId === 'demo') throw new Error('Refusing to snapshot the demo page itself');

const posts = await fetchAll(() => db.from('posts').select('*').eq('page_id', pageId)
  .not('photo_url', 'is', null).order('id'));
const byTime = [...posts].sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
const byScore = [...posts].sort((a, b) => b.engagement_score - a.engagement_score);
const chosen = new Map();
for (const p of [...byTime.slice(0, POSTS_RECENT), ...byScore.slice(0, POSTS_TOP + POSTS_RECENT)]) {
  if (chosen.size >= POSTS_RECENT + POSTS_TOP) break;
  chosen.set(p.id, p);
}

const postIds = [...chosen.keys()];
const idMap = new Map(postIds.map((id, i) => [id, `demo_p${i + 1}`]));

const tags = await fetchAll(() => db.from('post_tags').select('*').in('post_id', postIds).order('post_id'));
const comments = [];
for (let i = 0; i < postIds.length; i += 50) {
  const rows = await fetchAll(() => db.from('comments').select('*')
    .in('post_id', postIds.slice(i, i + 50)).order('id'));
  comments.push(...rows);
}
const perPost = {};
const keptComments = comments.filter((c) => (perPost[c.post_id] = (perPost[c.post_id] || 0) + 1) <= COMMENTS_PER_POST);

const snapshot = {
  exportedAt: new Date().toISOString(),
  page: { id: 'demo', name: 'Demo Shop', language: 'banglish' },
  posts: [...chosen.values()].map((p) => ({
    id: idMap.get(p.id), message: scrub(p.message), photo_url: p.photo_url, created_time: p.created_time,
    reactions: p.reactions, comments_count: p.comments_count, shares: p.shares,
    engagement_score: p.engagement_score, is_boosted: p.is_boosted,
  })),
  comments: keptComments.map((c, i) => ({
    id: `demo_c${i + 1}`, post_id: idMap.get(c.post_id), message: scrub(c.message),
    created_time: c.created_time, intent: c.intent, size: c.size, color: c.color,
  })),
  post_tags: tags.map((t) => ({ ...t, post_id: idMap.get(t.post_id), created_at: undefined })),
};

fs.writeFileSync(new URL('../demo/snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 1));
console.log(`posts ${snapshot.posts.length}, comments ${snapshot.comments.length}, tags ${snapshot.post_tags.length}`);
