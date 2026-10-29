import { db } from './db.js';
import { completeJSON } from './ai.js';

const MIN_POSTS = 3; // a group smaller than this is noise, not a pattern
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
// Median, so one viral post does not drag a whole group up.
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (n) => Math.round(n * 10) / 10;
const WORDS = { 2: 'twice', 2.5: 'two and a half times', 3: 'three times', 3.5: 'three and a half times', 4: 'four times',
  4.5: 'four and a half times', 5: 'five times', 5.5: 'five and a half times', 6: 'six times', 6.5: 'six and a half times',
  7: 'seven times', 7.5: 'seven and a half times', 8: 'eight times', 8.5: 'eight and a half times', 9: 'nine times',
  9.5: 'nine and a half times', 10: 'ten times' };

// A lift (group median / typical median) in plain words. Nobody should read "105.8 times".
export function plainLift(ratio) {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio > MAX_LIFT) return 'far more than ten times the engagement of your typical post';
  if (ratio >= 1.9) return `about ${WORDS[Math.min(10, Math.round(ratio * 2) / 2)]} the engagement of your typical post`;
  if (ratio >= 1.5) return 'nearly twice the engagement of your typical post';
  if (ratio >= 1.25) return 'clearly more engagement than your typical post';
  if (ratio >= 1.1) return 'a little more engagement than your typical post';
  if (ratio >= 0.9) return 'about the same engagement as your typical post';
  if (ratio >= 0.6) return 'somewhat less engagement than your typical post';
  if (ratio >= 0.4) return 'about half the engagement of your typical post';
  return 'much less engagement than your typical post';
}

// Headline needs at least this many posts behind it.
const HEADLINE_POSTS = 10;
const MAX_LIFT = 10; // a group more than this many times the typical post is more likely a quirk than a pattern
const UNUSUAL_MIN_LIFT = 1.5;
const PRICE_SHARE_ALERT_PCT = 20;

// Pure: posts, tags (by post id) and buying-comment counts (by post id) in, patterns out.
// Groups are compared on median engagement. Ranking uses lift (as a fraction, 0.91 = +91%) times sqrt(posts),
// so a big group with a solid lift outranks a tiny one with a huge lift.
export function computePatterns(posts, tags, buying) {
  const organic = posts.filter((p) => !p.is_boosted);
  const base = {
    engagement: median(organic.map((p) => Number(p.engagement_score))),
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
      const engagement = median(ps.map((p) => Number(p.engagement_score)));
      const ratio = base.engagement ? engagement / base.engagement : null;
      return {
        value, posts: ps.length,
        median_engagement: round(engagement), lift: ratio == null ? null : Math.round(ratio * 100) / 100,
        vs_typical: plainLift(ratio),
        rank_score: ratio == null ? null : round((ratio - 1) * Math.sqrt(ps.length)),
        avg_buyer_comments: round(avg(ps.map((p) => buying.get(p.id) || 0))),
      };
    }).sort((a, b) => b.median_engagement - a.median_engagement);
    if (rows.length >= 2) dimensions.push({ key, label: dim.label, groups: rows }); // one group has nothing to compare with
  }

  const all = dimensions.flatMap((d) => d.groups.filter((g) => g.lift != null).map((g) => ({ dimension: d.key, label: d.label, ...g })));
  // Headline candidates: enough posts and a believable lift, best adjusted lift first.
  const ranked = all.filter((g) => g.posts >= HEADLINE_POSTS && g.lift <= MAX_LIFT).sort((a, b) => b.rank_score - a.rank_score);
  const strongest = ranked[0]?.lift > 1 ? ranked[0] : null;
  // Strong-looking groups that cannot be the headline: thin evidence or an extreme jump. Shown as "worth checking".
  const unusual = all.filter((g) => g.lift >= UNUSUAL_MIN_LIFT && (g.posts < HEADLINE_POSTS || g.lift > MAX_LIFT))
    .sort((a, b) => b.lift - a.lift).slice(0, 5)
    .map((g) => ({ ...g, reason: g.lift > MAX_LIFT ? 'extreme jump' : 'few posts' }));

  // Price shown vs not: always computed, even when one side is too small to rank.
  const side = (flag) => {
    const ps = organic.filter((p) => tags.get(p.id) && tags.get(p.id).price_shown === flag);
    const m = median(ps.map((p) => Number(p.engagement_score)));
    return { posts: ps.length, median_engagement: round(m) };
  };
  const price = { shown: side(true), not_shown: side(false) };
  price.enough = price.shown.posts >= MIN_POSTS && price.not_shown.posts >= MIN_POSTS;

  return {
    basis: { posts: organic.length, boosted_excluded: posts.length - organic.length, median_engagement: round(base.engagement), avg_buyer_comments: round(base.buyer_comments) },
    strongest,
    ranked: ranked.slice(0, 8),
    unusual,
    price,
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

// What the model gets: plain-word lifts and post counts only. Unusual patterns are left out on purpose:
// they are shown to the owner as "worth checking", never as findings.
function modelInput(patterns, intents, price_question_share_pct) {
  const group = (g) => ({ value: g.value, posts: g.posts, vs_typical: g.vs_typical });
  const named = Object.fromEntries(Object.entries(intents).map(([k, n]) => [INTENT_LABELS[k] || k, n]));
  return {
    posts_compared: patterns.basis.posts,
    strongest: patterns.strongest && { pattern: patterns.strongest.label, ...group(patterns.strongest) },
    ranked: patterns.ranked.map((g) => ({ dimension: g.dimension, pattern: g.label, ...group(g) })),
    patterns: patterns.dimensions.map((d) => ({ dimension: d.key, pattern: d.label, groups: d.groups.map(group) })),
    price_question_share_pct,
    comment_intents: named,
  };
}

async function explain(patterns, intents, price_question_share_pct) {
  const input = modelInput(patterns, intents, price_question_share_pct);
  const prompt = `You explain what works on a small seller's Facebook page, in plain, friendly English a shopkeeper understands.
Below are results computed from the page's own posts. For each group of posts, "vs_typical" says in words how its engagement compares with the page's typical post. "strongest" is the best pattern (null if no pattern has ${HEADLINE_POSTS} or more posts behind it); "ranked" lists the best patterns in order. "comment_intents" counts what customers' comments are about.
Rules:
- Use ONLY what is in the data. Quote each group's "vs_typical" wording exactly as written (for example "about twice the engagement of your typical post"). Never write a percentage, never write "times" with a digit, never compute new numbers, and do not guess causes. The only digits allowed are post counts and comment counts copied from the data.
- headline: one sentence about the strongest pattern, with its post count. If strongest is null, say that no pattern has ${HEADLINE_POSTS} or more posts behind it yet.
- supporting: 2 to 4 more findings from other patterns or from comment_intents; each has "dimension" (a key from the data, or "comment_intents") and one-sentence "text".
- actions: exactly 3 different, concrete instructions for the seller's next posts, each a full sentence that starts with a verb (for example "Post your next discount offer in the evening."), without numbers. Do not write an action about showing the price: that is added separately.

${JSON.stringify(input)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: s } = await completeJSON('playbook', {
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'playbook_summary', schema: SUMMARY_SCHEMA } },
    }, {
      validate: (d) => {
        if (typeof d?.headline !== 'string' || !Array.isArray(d.supporting) || !Array.isArray(d.actions)) {
          throw new Error('answer is missing headline, supporting or actions');
        }
      },
    });
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

async function compute(pageId, overrides = {}) {
  const posts = (await fetchAll(() => db.from('posts')
    .select('id, message, photo_url, created_time, reactions, comments_count, shares, engagement_score, is_boosted')
    .eq('page_id', pageId).order('id')))
    .map((p) => (p.id in overrides ? { ...p, is_boosted: overrides[p.id] } : p)); // overrides: a visitor's own boosted flags
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
  const price_comments = intents.price_question || 0;
  patterns.price.question_comments = price_comments;
  patterns.price.classified_comments = comments.length;
  patterns.price.share_pct = comments.length ? Math.round((price_comments / comments.length) * 100) : 0;
  // Best posts overall, boosted ones included and flagged, so the owner can mark one as boosted.
  const top_posts = posts.filter((p) => p.photo_url)
    .sort((a, b) => b.engagement_score - a.engagement_score).slice(0, 5)
    .map((p) => ({
      id: p.id, caption: (p.message || '').slice(0, 200), photo_url: p.photo_url, is_boosted: p.is_boosted,
      engagement_score: Number(p.engagement_score), buyer_comments: buying.get(p.id) || 0,
    }));
  return { patterns, intents, top_posts, classified_comments: comments.length };
}

// Written in code, not by the model, so the numbers are exact: when many comments ask the price,
// every post should show it.
function priceAction({ price }) {
  if (price.share_pct <= PRICE_SHARE_ALERT_PCT) return null;
  let text = `Show the price in every post: ${price.share_pct}% of comments (${price.question_comments} of ${price.classified_comments}) ask for it.`;
  // The comparison only goes in when both sides have enough posts and the gap is believable.
  const { shown, not_shown } = price;
  const ratio = not_shown.median_engagement ? shown.median_engagement / not_shown.median_engagement : null;
  if (shown.posts >= HEADLINE_POSTS && not_shown.posts >= HEADLINE_POSTS && ratio != null && ratio >= 1.1 && ratio <= MAX_LIFT) {
    text += ` Posts that show a price get ${plainLift(ratio).replace(' of your typical post', ' of posts without one')} (${shown.posts} posts against ${not_shown.posts}).`;
  }
  return text;
}

// Everything the screen needs, computed from current data (plus optional per-visitor boosted overrides).
async function assemble(pageId, overrides) {
  const { patterns, intents, top_posts, classified_comments } = await compute(pageId, overrides);
  let summary = null;
  let failed = 0;
  if (patterns.dimensions.length) {
    try {
      summary = await explain(patterns, intents, patterns.price.share_pct);
      const alert = priceAction(patterns);
      if (alert) {
        // keep the model's other actions, drop any price action it wrote anyway, lead with ours
        summary.actions = [alert, ...summary.actions.filter((a) => !/price/i.test(a))].slice(0, 3);
      }
    } catch (e) { failed = 1; console.error('playbook explanation failed:', e.status ?? '', JSON.stringify(e.error ?? e.message)); }
  }
  return { data: { ...patterns, intents, top_posts, classified_comments }, summary, failed };
}

// One build at a time per page: a second request waits for the first, then rebuilds with fresh data.
const queue = new Map();

async function build(pageId) {
  const { data, summary, failed } = await assemble(pageId, {});
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

// Demo mode: the visitor's boosted flags come with the request and nothing is written anywhere.
// Results are kept in memory by flag set, so repeated toggles don't repeat the model call.
const previews = new Map();
export async function previewPlaybook(pageId, boosted) {
  const overrides = Object.fromEntries(Object.entries(boosted || {}).filter(([, v]) => typeof v === 'boolean'));
  const key = `${pageId}:${JSON.stringify(Object.entries(overrides).sort())}`;
  if (!previews.has(key)) {
    const { data, summary } = await assemble(pageId, overrides);
    if (previews.size >= 100) previews.delete(previews.keys().next().value);
    previews.set(key, { status: 'ready', data, summary, created_at: new Date().toISOString() });
  }
  return previews.get(key);
}
