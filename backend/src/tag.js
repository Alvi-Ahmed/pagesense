import { db } from './db.js';
import sharp from 'sharp';
import { meta, MODELS } from './meta.js';

const BATCH_SIZE = 20; // API allows 50 images per request; smaller keeps payloads and retries cheap

const WORN = ['worn', 'flat', 'unknown'];
const OFFERS = ['none', 'discount', 'free_delivery', 'combo', 'new_arrival', 'clearance', 'other'];

const SCHEMA = {
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          product_type: { type: 'string' },
          product_phrase: { type: 'string' },
          worn_or_flat: { type: 'string', enum: WORN },
          background: { type: 'string' },
          price_shown: { type: 'boolean' },
          offer_type: { type: 'string', enum: OFFERS },
        },
        required: ['post_id', 'product_type', 'product_phrase', 'worn_or_flat',
          'background', 'price_shown', 'offer_type'],
        additionalProperties: false,
      },
    },
  },
  required: ['tags'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You tag product photos from a small seller's Facebook page. Captions may be Bangla script, English, or Banglish (Bangla in English letters).
For each post (an id, its caption, then its photo) return one object with:
- post_id: copied exactly from the input
- product_type: short category in English, e.g. "saree", "panjabi", "handbag"; "none" if the photo shows no product
- product_phrase: a concrete English noun phrase naming the main product as it looks, e.g. "red cotton saree" (used to locate the product in the photo)
- worn_or_flat: "worn" if on a person or mannequin, "flat" if laid out or on a surface, else "unknown"
- background: a few words, e.g. "plain white wall", "outdoor garden", "cluttered room"
- price_shown: true if a price appears in the photo or caption
- offer_type: one of ${OFFERS.join(', ')}
Return one object per post, in the same order.`;

const job = new Map();
export const getTagStatus = (pageId) => job.get(pageId) || { status: 'idle' };

// Meta's API can't fetch Facebook CDN urls ("URL is not fetchable"), so we download the photo
// ourselves and send it inline, shrunk: tagging doesn't need full resolution.
async function photoDataUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`photo download failed: HTTP ${res.status}`);
  const jpeg = await sharp(Buffer.from(await res.arrayBuffer()))
    .rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function buildContent(posts) {
  const content = [{ type: 'text', text: INSTRUCTIONS }];
  for (const p of posts) {
    content.push({ type: 'text', text: `post_id: ${p.id}\ncaption: ${(p.message || '').slice(0, 500) || '(none)'}` });
    content.push({ type: 'image_url', image_url: { url: p.image } });
  }
  return content;
}

// One model call for a batch. Returns rows for post_tags; ids the model skipped or invented are dropped.
// Posts whose photo can't be downloaded are left out (and retried on a later run).
export async function tagBatch(allPosts) {
  const loaded = await Promise.all(allPosts.map(async (p) => {
    try { return { ...p, image: p.photo_url.startsWith('data:') ? p.photo_url : await photoDataUrl(p.photo_url) }; }
    catch (e) { console.error('photo skipped', p.id, e.message); return null; }
  }));
  const posts = loaded.filter(Boolean);
  if (!posts.length) return [];
  const res = await meta.chat.completions.create({
    model: MODELS.spark,
    reasoning_effort: 'minimal', // lowest muse-spark-1.3 accepts; "none" returns 400
    messages: [{ role: 'user', content: buildContent(posts) }],
    response_format: { type: 'json_schema', json_schema: { name: 'post_tags', schema: SCHEMA } },
  });
  const { tags } = JSON.parse(res.choices[0].message.content);
  const ids = new Set(posts.map((p) => p.id));
  const seen = new Set();
  return tags.filter((t) => ids.has(t.post_id) && !seen.has(t.post_id) && seen.add(t.post_id));
}

async function fetchAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// Posts with a photo and no post_tags row yet.
async function untaggedPosts(pageId) {
  const tagged = new Set((await fetchAll(() =>
    db.from('post_tags').select('post_id, posts!inner(page_id)').eq('posts.page_id', pageId).order('post_id')
  )).map((r) => r.post_id));
  const posts = await fetchAll(() =>
    db.from('posts').select('id, message, photo_url').eq('page_id', pageId)
      .not('photo_url', 'is', null).order('id')
  );
  return posts.filter((p) => !tagged.has(p.id));
}

async function save(rows, state) {
  if (!rows.length) return;
  const { error } = await db.from('post_tags').upsert(rows);
  if (error) throw new Error(`post_tags: ${error.message}`);
  state.tagged += rows.length;
}

async function run(pageId, limit, state) {
  let todo = await untaggedPosts(pageId);
  if (limit) todo = todo.slice(0, limit);
  state.total = todo.length;
  await state.onProgress?.(0, todo.length);

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    try {
      const rows = await tagBatch(batch);
      await save(rows, state);
      state.failed += batch.length - rows.length; // skipped photos or posts the model left out
    } catch (e) {
      // A bad image (e.g. expired CDN url) fails the whole call: retry one by one so only that post is lost.
      console.error('tag batch failed, retrying singly:', e.message);
      for (const p of batch) {
        try {
          const rows = await tagBatch([p]);
          await save(rows, state);
          state.failed += 1 - rows.length;
        }
        catch (err) { state.failed++; console.error('tag failed', p.id, err.message); }
      }
    }
    state.processed = Math.min(i + BATCH_SIZE, todo.length);
    await state.onProgress?.(state.processed, todo.length);
  }
}

// Used by the analysis pipeline: tags every untagged photo post and reports progress.
export async function tagPage(pageId, { progress } = {}) {
  const state = { total: 0, processed: 0, tagged: 0, failed: 0, onProgress: progress };
  await run(pageId, 0, state);
  return { tagged: state.tagged, failed: state.failed };
}

// Starts a background tagging run; already-tagged posts are skipped. One run per page at a time.
export function startTagging(pageId, limit) {
  if (job.get(pageId)?.status === 'running') return job.get(pageId);
  const state = { status: 'running', total: 0, processed: 0, tagged: 0, failed: 0, startedAt: new Date().toISOString() };
  job.set(pageId, state);
  run(pageId, limit, state)
    .then(() => { state.status = 'done'; })
    .catch((e) => { console.error('tagging failed', pageId, e.message); state.status = 'error'; state.error = e.message; })
    .finally(() => { state.finishedAt = new Date().toISOString(); });
  return state;
}
