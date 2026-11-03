import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { checkCaption, detectLanguage, stripAliases, removeNames, scrub } from './generate.js';
import { getProduct, similarInStock } from './catalog.js';
import { numbersIn } from './textutil.js';
import { hasColumns } from './schema.js';
import { showableUrl } from './photos.js';

// Item 8: when a product sells out (or comes back) its posts still say "order now". For each linked post this
// proposes a caption update: the original with a clear SOLD OUT line (and a pointer to a similar in-stock product
// from the catalog), or a BACK IN STOCK line. Same grounding as post generation; the owner reviews every one.
const MAX_ATTEMPTS = 3;
const DEFAULT_POSTS = 5;
const CONCURRENCY = 3;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const SOLD = /sold\s*out|stock\s*out|out of stock|স্টক\s*আউট|বিক্রি\s*শেষ|শেষ/i;
const BACK = /back in stock|restock|আবার\s*(?:পাওয়া|স্টকে)|ফিরে\s*এসেছে|স্টকে\s*এসেছে/i;

const SCHEMA = {
  type: 'object',
  properties: { caption: { type: 'string' } },
  required: ['caption'],
  additionalProperties: false,
};

const wordSet = (t) => new Set(String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));

function prompt({ kind, original, product, similar, problems }) {
  const sold = kind === 'sold_out';
  return `You update an existing Facebook post caption for a small seller in Bangladesh because this product is now ${sold ? 'SOLD OUT' : 'BACK IN STOCK'}.

ORIGINAL CAPTION:
${JSON.stringify(clip(original, 1500))}

THE PRODUCT: ${JSON.stringify({ name: product.name, type: product.type })}
${sold
    ? (similar
      ? `A SIMILAR PRODUCT STILL AVAILABLE (the only other product you may mention): ${JSON.stringify({ name: similar.name, price: similar.price })}. Add one short line pointing customers to it${similar.price == null ? ' (it has no known price: do not write one)' : ''}.`
      : 'No similar product is available: do not point customers to any other product.')
    : ''}

RULES (all enforced by code; a caption that breaks one is thrown away):
- Write in the SAME language and script as the original caption, and keep its tone, emoji and layout.
- Keep every fact of the original exactly as it is. Add no new facts.
- ${sold
    ? 'Put a clear sold-out line at the very top, for example "SOLD OUT ❌" (in the caption\'s language). Take out wording that asks customers to order or pre-order this product now.'
    : 'Put a clear "BACK IN STOCK ✅" line at the very top (in the caption\'s language) and remove any sold-out wording.'}
- Never invent a price, discount, size, color, delivery charge or stock count. Any number you write must already be in the original caption${sold && similar?.price != null ? ' or be the similar product\'s price' : ''}.
- No customer names, no @mentions, no links. Plain text only: no ** or markdown.
Return JSON: {"caption": "..."}.
${problems?.length ? `\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems:\n- ${problems.join('\n- ')}\n` : ''}`;
}

// A post with no caption of its own gets a plain line, no model needed.
function plainLine(kind, similar) {
  if (kind === 'restock') return 'BACK IN STOCK ✅';
  return `SOLD OUT ❌${similar ? `\nSimilar: ${similar.name}${similar.price != null ? ` - Tk ${similar.price}` : ''}` : ''}`;
}

async function suggestOne({ kind, post, product, similar }) {
  const original = stripAliases(scrub(post.caption || ''));
  if (original.length < 10) return { caption: plainLine(kind, similar), original: post.caption || '', attempts: 0 };
  const cleaned = await removeNames([original]);
  const text = cleaned.texts[0];
  const facts = similar ? JSON.stringify({ name: similar.name, price: similar.price }) : '';
  const known = `${text} ${facts} ${kind === 'sold_out' ? 'sold out' : 'back in stock'}`;
  const allowed = numbersIn(`${text} ${similar?.price ?? ''}`);
  const claim = kind === 'sold_out' ? SOLD : BACK;
  const language = detectLanguage(text);
  const origWords = wordSet(text);

  let problems = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data } = await completeJSON('post_generation', {
      messages: [{ role: 'user', content: prompt({ kind, original: text, product, similar, problems }) }],
      response_format: { type: 'json_schema', json_schema: { name: 'caption_update', schema: SCHEMA } },
    }, { validate: (d) => { if (typeof d?.caption !== 'string') throw new Error('answer has no caption'); } });
    const caption = data.caption.trim();
    problems = checkCaption(caption, { allowedNumbers: allowed, knownText: known, priceRequired: false, language, forbiddenNames: cleaned.names });
    if (!claim.test(caption)) problems.push(kind === 'sold_out' ? 'the caption must say clearly that the product is SOLD OUT' : 'the caption must say clearly that it is BACK IN STOCK');
    if (kind === 'restock' && SOLD.test(caption) && !BACK.test(caption.split('\n')[0])) problems.push('remove the sold-out wording');
    const kept = [...origWords].filter((w) => wordSet(caption).has(w)).length / Math.max(origWords.size, 1);
    if (kept < 0.5) problems.push('keep the original caption: most of its words must stay');
    if (similar && kind === 'sold_out' && /\bsimilar\b|সদৃশ/i.test(caption) === false && !caption.toLowerCase().includes(similar.name.toLowerCase().split(/\s+/)[0])) { /* a pointer is welcome, not required */ }
    if (!problems.length) return { caption, original: text, attempts: attempt };
    console.error(`caption update rejected (attempt ${attempt}/${MAX_ATTEMPTS}):`, problems.join(' | '));
  }
  return { caption: null, original: text, attempts: MAX_ATTEMPTS, problems };
}

const tableReady = () => db.from('caption_updates').select('id').limit(1).then(({ error }) => !error);

// Suggestions for the newest posts of a product (or the posts asked for). Saved for real pages so the owner can
// come back; the demo is read-only, so its suggestions only go back to the browser.
export async function suggestUpdates(pageId, productId, { kind = 'sold_out', postIds, limit = DEFAULT_POSTS, save = true, trustKind = false } = {}) {
  if (!['sold_out', 'restock'].includes(kind)) throw fail('kind must be sold_out or restock');
  const product = await getProduct(pageId, productId);
  if (!trustKind) { // the demo cannot change a status on the server, so it states the kind and nothing is written
    if (kind === 'sold_out' && product.status !== 'sold_out') throw fail('Mark the product sold out first.', 409);
    if (kind === 'restock' && product.status === 'sold_out') throw fail('Restock the product first.', 409);
  }
  const wanted = Array.isArray(postIds) && postIds.length ? new Set(postIds) : null;
  const targets = (wanted ? product.linked_posts.filter((p) => wanted.has(p.id)) : product.linked_posts.slice(0, Math.min(Number(limit) || DEFAULT_POSTS, 20)));
  const similar = kind === 'sold_out' ? await similarInStock(pageId, product) : null;
  const similarView = similar && { id: similar.id, name: similar.name, price: similar.price };

  const out = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    out.push(...await Promise.all(targets.slice(i, i + CONCURRENCY).map(async (post) => {
      try {
        const r = await suggestOne({ kind, post, product, similar: similarView });
        return { post_id: post.id, photo_url: await showableUrl(post.photo_url), original_caption: r.original, caption: r.caption, problems: r.problems ?? null, similar: similarView, attempts: r.attempts };
      } catch (e) {
        console.error('caption update failed:', e.status ?? '', JSON.stringify(e.error ?? e.message));
        return { post_id: post.id, photo_url: await showableUrl(post.photo_url), original_caption: post.caption, caption: null, problems: ['The suggestion could not be written. Try again.'], similar: similarView, attempts: 0 };
      }
    })));
  }
  if (save && await tableReady()) {
    const rows = out.filter((s) => s.caption).map((s) => ({ page_id: pageId, product_id: productId, post_id: s.post_id, kind, original_caption: s.original_caption, caption: s.caption, similar_product: s.similar }));
    if (rows.length) { const { error } = await db.from('caption_updates').insert(rows); if (error) console.error('could not save caption updates:', error.message); }
  }
  return { kind, product: { id: product.id, name: product.name, status: product.status }, similar: similarView, suggestions: out, more_posts: Math.max(product.linked_posts.length - targets.length, 0), total_posts: product.linked_posts.length };
}

// The latest saved suggestion for each post of a product.
export async function savedUpdates(pageId, productId, kind) {
  if (!(await tableReady())) return { suggestions: [] };
  const { data, error } = await db.from('caption_updates').select('*').eq('page_id', pageId).eq('product_id', productId).eq('kind', kind).order('created_at', { ascending: false });
  if (error) throw error;
  const seen = new Set();
  const latest = data.filter((r) => !seen.has(r.post_id) && seen.add(r.post_id));
  const photos = new Map();
  if (latest.length) {
    const { data: posts } = await db.from('posts').select('id, photo_url').in('id', latest.map((r) => r.post_id));
    for (const p of posts ?? []) photos.set(p.id, await showableUrl(p.photo_url));
  }
  return { suggestions: latest.map((r) => ({ post_id: r.post_id, photo_url: photos.get(r.post_id) ?? null, original_caption: r.original_caption, caption: r.caption, similar: r.similar_product, created_at: r.created_at })) };
}
