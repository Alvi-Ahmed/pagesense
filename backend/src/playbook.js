import { db } from './db.js';
import { bulkChat } from './meta.js';

const MIN_POSTS = 3; // a group smaller than this is noise, not a pattern
const STRONG_POSTS = 5; // the "strongest pattern" prefers groups at least this big
const BUYING = ['order_intent', 'price_question', 'size_or_color_request', 'stock_or_restock',
  'delivery_question', 'negotiation'];
const DHAKA_OFFSET_MS = 6 * 3600_000; // posting times are read in Bangladesh time

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// post_tags.background is free text ("plain white wall", "wooden floor indoors"); group it into a few styles.
export function backgroundStyle(text) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  if (/outdoor|sky|grass|sidewalk|pavement|street|garden|park/.test(t)) return 'outdoors';
  if (/plain|studio|backdrop|gradient|graphic/.test(t)) return 'plain or studio';
  if (/cluttered|room|sofa|bed|carpet|hallway|shelf|window|chair|decor|magazine|floor|table|basket|luggage|indoor|home/.test(t)) return 'home setting';
  if (/wall|background|surface|tissue|fabric|sheet|box|dark|white|beige|cream/.test(t)) return 'plain or studio';
  return null;
}

const dhaka = (p) => new Date(+new Date(p.created_time) + DHAKA_OFFSET_MS);

const DIMENSIONS = {
  offer_type: { label: 'Offer', tag: true, value: (t) => t.offer_type?.replaceAll('_', ' ') },
  worn_or_flat: { label: 'Worn or flat photo', tag: true, value: (t) => (t.worn_or_flat !== 'unknown' ? t.worn_or_flat : null) },
  price_shown: { label: 'Price in post', tag: true, value: (t) => (t.price_shown == null ? null : t.price_shown ? 'price shown' : 'no price') },
  background_style: { label: 'Photo background', tag: true, value: (t) => backgroundStyle(t.background) },
  weekday: { label: 'Day posted', value: (_t, p) => DAYS[dhaka(p).getUTCDay()] },
  time_of_day: {
    label: 'Time posted',
    value: (_t, p) => {
      const h = dhaka(p).getUTCHours();
      return h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night';
    },
  },
};

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n) => Math.round(n * 10) / 10;
// Signed whole-number percent difference from the page average, e.g. +91 or -20.
const pctVs = (value, base) => (base ? Math.round((value / base - 1) * 100) : null);

// Pure: posts, tags (by post id) and buying-comment counts (by post id) in, patterns out.
export function computePatterns(posts, tags, buying) {
  const organic = posts.filter((p) => !p.is_boosted);
  const base = {
    engagement: avg(organic.map((p) => Number(p.engagement_score))),
    buyer_comments: avg(organic.map((p) => buying.get(p.id) || 0)),
  };
  const dimensions = [];
  for (const [key, dim] of Object.entries(DIMENSIONS)) {
    const groups = new Map();
    for (const p of organic) {
      const tag = tags.get(p.id);
      if (dim.tag && !tag) continue;
      const v = dim.value(tag, p);
      if (v == null) continue;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(p);
    }
    const rows = [...groups].filter(([, ps]) => ps.length >= MIN_POSTS).map(([value, ps]) => {
      const engagement = avg(ps.map((p) => Number(p.engagement_score)));
      const buyer = avg(ps.map((p) => buying.get(p.id) || 0));
      return {
        value, posts: ps.length,
        avg_engagement: round(engagement), engagement_vs_page_pct: pctVs(engagement, base.engagement),
        avg_buyer_comments: round(buyer), buyer_comments_vs_page_pct: pctVs(buyer, base.buyer_comments),
      };
    }).sort((a, b) => b.avg_engagement - a.avg_engagement);
    if (rows.length >= 2) dimensions.push({ key, label: dim.label, groups: rows }); // one group has nothing to compare with
  }

  // Strongest pattern: the group furthest above the page average, preferring groups of 5+ posts.
  let strongest = null;
  for (const minPosts of [STRONG_POSTS, MIN_POSTS]) {
    for (const d of dimensions) {
      for (const g of d.groups) {
        if (g.posts >= minPosts && (!strongest || g.engagement_vs_page_pct > strongest.engagement_vs_page_pct)) {
          strongest = { dimension: d.key, label: d.label, value: g.value, posts: g.posts, engagement_vs_page_pct: g.engagement_vs_page_pct };
        }
      }
    }
    if (strongest) break;
  }
  return {
    basis: { posts: organic.length, boosted_excluded: posts.length - organic.length, avg_engagement: round(base.engagement), avg_buyer_comments: round(base.buyer_comments) },
    strongest,
    dimensions,
  };
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    supporting: {
      type: 'array',
      items: {
        type: 'object',
        properties: { dimension: { type: 'string' }, text: { type: 'string' } },
        required: ['dimension', 'text'],
        additionalProperties: false,
      },
    },
    actions: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'supporting', 'actions'],
  additionalProperties: false,
};

const numbersIn = (text) => new Set(String(text).match(/\d+(?:\.\d+)?/g) || []);

// The model may only quote numbers it was given. Returns the first stray number, or null.
function strayNumber(summary, input) {
  const allowed = numbersIn(JSON.stringify(input));
  const texts = [summary.headline, ...summary.supporting.map((s) => s.text), ...summary.actions];
  for (const t of texts) for (const n of numbersIn(t)) if (!allowed.has(n)) return n;
  return null;
}

export const INTENT_LABELS = {
  price_question: 'asking the price', size_or_color_request: 'asking for a size or color', stock_or_restock: 'asking if it is in stock',
  order_intent: 'wanting to order', interested: 'showing interest', delivery_question: 'asking about delivery',
  product_question: 'asking about the product', complaint: 'complaining', negotiation: 'asking for a discount',
  praise: 'praising', other: 'other (tags, greetings, seller replies)',
};

async function explain(patterns, intents) {
  const named = Object.fromEntries(Object.entries(intents).map(([k, n]) => [INTENT_LABELS[k] || k, n]));
  const input = { ...patterns, comment_intents: named };
  const prompt = `You explain what works on a small seller's Facebook page, in plain, friendly English a shopkeeper understands.
Below are numbers computed from the page's own posts. "engagement_vs_page_pct" says how much higher (positive) or lower (negative) a group's average engagement is than the page average; "buyer_comments_vs_page_pct" is the same for comments asking to buy (price, size, stock, order). "strongest" is the pattern with the biggest lift. "comment_intents" counts what customers' comments are about.
Rules:
- Use ONLY numbers that appear in the data. Quote percentages and post counts exactly as given (for example "91% above average", "based on 49 posts"). Never compute new numbers, never write any other number, and do not guess causes.
- headline: one sentence about the strongest pattern, with its post count.
- supporting: 2 to 4 more findings from other patterns or from comment_intents; each has "dimension" (a key from the data, or "comment_intents") and one-sentence "text".
- actions: exactly 3 different, concrete instructions for the seller's next posts, each a full sentence that starts with a verb (for example "Post your next discount offer in the evening."), without numbers.

${JSON.stringify(input)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await bulkChat({
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'playbook_summary', schema: SUMMARY_SCHEMA } },
    });
    const s = JSON.parse(res.choices[0].message.content);
    s.supporting = s.supporting.slice(0, 4);
    s.actions = s.actions.slice(0, 3);
    const stray = strayNumber(s, input);
    const actionsOk = s.actions.length === 3 && new Set(s.actions).size === 3 && s.actions.every((a) => a.trim().split(/\s+/).length >= 4);
    if (s.supporting.length >= 2 && actionsOk && !stray) return s;
    console.error(`playbook explanation rejected (attempt ${attempt + 1}):`,
      stray ? `number ${stray} not in the data` : `${s.supporting.length} supporting / actions ${JSON.stringify(s.actions)}`);
  }
  throw new Error('playbook explanation did not pass validation');
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

async function compute(pageId) {
  const posts = await fetchAll(() => db.from('posts')
    .select('id, message, photo_url, created_time, reactions, comments_count, shares, engagement_score, is_boosted')
    .eq('page_id', pageId).order('id'));
  const tags = new Map((await fetchAll(() => db.from('post_tags')
    .select('*, posts!inner(page_id)').eq('posts.page_id', pageId).order('post_id'))).map((t) => [t.post_id, t]));
  const comments = await fetchAll(() => db.from('comments')
    .select('post_id, intent, posts!inner(page_id)').eq('posts.page_id', pageId).not('intent', 'is', null).order('id'));

  const intents = {};
  const buying = new Map();
  for (const c of comments) {
    intents[c.intent] = (intents[c.intent] || 0) + 1;
    if (BUYING.includes(c.intent)) buying.set(c.post_id, (buying.get(c.post_id) || 0) + 1);
  }
  const patterns = computePatterns(posts, tags, buying);
  // Best posts overall, boosted ones included and flagged, so the owner can mark one as boosted.
  const top_posts = posts.filter((p) => p.photo_url)
    .sort((a, b) => b.engagement_score - a.engagement_score).slice(0, 5)
    .map((p) => ({
      id: p.id, caption: (p.message || '').slice(0, 200), photo_url: p.photo_url, is_boosted: p.is_boosted,
      engagement_score: Number(p.engagement_score), buyer_comments: buying.get(p.id) || 0,
    }));
  return { patterns, intents, top_posts, classified_comments: comments.length };
}

// One build at a time per page: a second request waits for the first, then rebuilds with fresh data.
const queue = new Map();

async function build(pageId) {
  const { patterns, intents, top_posts, classified_comments } = await compute(pageId);
  let summary = null;
  let failed = 0;
  if (patterns.dimensions.length) {
    try { summary = await explain(patterns, intents); }
    catch (e) { failed = 1; console.error('playbook explanation failed:', e.status ?? '', JSON.stringify(e.error ?? e.message)); }
  }
  const data = { ...patterns, intents, top_posts, classified_comments };
  const { error } = await db.from('playbooks').insert({ page_id: pageId, data, summary });
  if (error) throw new Error(`playbooks: ${error.message}`);
  return { done: 1, failed };
}

// Stage of the analysis job; also used after the owner flips a post's boosted flag.
export async function buildPlaybook(pageId, { progress } = {}) {
  await progress?.(0, 1);
  const run = (queue.get(pageId) || Promise.resolve()).catch(() => {}).then(() => build(pageId));
  queue.set(pageId, run);
  const result = await run;
  await progress?.(1, 1);
  return result;
}

export async function latestPlaybook(pageId) {
  const { data, error } = await db.from('playbooks').select('data, summary, created_at')
    .eq('page_id', pageId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? { status: 'ready', ...data } : { status: 'none' };
}

// The owner says whether a post was boosted; boosted posts are left out of every pattern.
export async function setBoosted(pageId, postId, boosted) {
  const { data, error } = await db.from('posts').update({ is_boosted: boosted })
    .eq('id', postId).eq('page_id', pageId).select('id');
  if (error) throw error;
  if (!data.length) throw Object.assign(new Error('Post not found on this page'), { status: 404 });
  await buildPlaybook(pageId);
  return latestPlaybook(pageId);
}
