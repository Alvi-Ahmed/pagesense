import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { INTENT_LABELS, latestPlaybook } from './playbook.js';
import { getProduct as getCatalogProduct } from './catalog.js';
import { lowStockThreshold } from './stock.js';
import { MAX_TOOL_CALLS, runAgent } from './agent.js';
import { randomUUID } from 'node:crypto';
import { numbersIn, toAscii } from './textutil.js';
import { findPersonalNames } from './names.js';
import { showableUrl } from './photos.js';
import { signedUrl } from './brand.js';

export const LANGUAGES = ['bangla', 'english', 'banglish'];
// Facts we may not know. The model must write these exactly instead of inventing a value.
export const PLACEHOLDERS = ['PRICE', 'SIZES', 'COLORS', 'DELIVERY CHARGE', 'STOCK'];
const PRICE_ALERT_PCT = 20; // at this share of price questions the caption must show the price (or [PRICE])
const MAX_ATTEMPTS = 3;
const EXAMPLES = 5;
const VIRAL_SKIP = 0.02; // best captions are picked after dropping the top 2% of posts: one viral hit is not a style

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

async function fetchAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// ---- text helpers ------------------------------------------------------------------------
// Bangla script, Banglish (Bangla words in Latin letters, recognised by common words) or English.
const BANGLISH_WORDS = new Set(('ache achhe achen nai nei hobe hoy hbe hobo korun korben korbo krmu korte koro kore korbe korsi kinbo kinte kinben kinum nibo nebo nite nilam nibe nimu dibo diben dite den dim dimu '
  + 'lagbe lagbey lagbei lagche chai chaii chaiiii chaina chacchi jonno jante janaben janan pabo paben pawa pabo pai paichi pathan pathaben pathabo pathiye kemon kemne kivabe kibhabe kevabey kobe koto kotodin koyta koita '
  + 'ekhon ekhoni ekhane okhane eta ota aita oita ei ami amar amr apni apnar apnara apu apa vai bhai bhaiya amra tomar tumi tui dam dami daam inbox bolen bolun bolo bolbo dekhan dekhben '
  + 'kotha naki jaiya jabo jete jaben thake thakbe shuru lage lagbo dorkar dorkari sundor shundor khub valo bhalo dhonnobad dhonnyobad').split(/\s+/));
const BANGLISH_SPLIT = /[^a-z]+/;

// Bangla script, Banglish (Bangla words in Latin letters) or English. Comments are short, so a couple of telltale
// words, or one in a very short comment, is enough.
export const detectLanguage = (t) => {
  if (bengaliShare(t) > 0.4) return 'bangla';
  const w = String(t ?? '').toLowerCase().split(BANGLISH_SPLIT).filter(Boolean);
  const hits = w.filter((x) => BANGLISH_WORDS.has(x)).length;
  return hits >= 2 || (hits >= 1 && w.length <= 6) ? 'banglish' : 'english';
};

const bengaliShare = (t) => {
  const letters = (t.match(/\p{L}/gu) || []).length;
  return letters ? (t.match(/[ঀ-৿]/g) || []).length / letters : 0;
};
// Page-written captions can carry phone numbers, links and tags of customers: none of that goes to the model.
export const scrub = (t) => String(t ?? '').replace(/https?:\/\/\S+|\bwww\.\S+/gi, '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
  .replace(/@\S+/g, '').replace(/\+?[\d০-৯][\d০-৯ \t\-().]{6,}[\d০-৯]/g, (m) => (m.replace(/[^\d০-৯]/g, '').length >= 9 ? '' : m)).trim();

export const stripAliases = (t) => t.replace(/\bCustomer\s*\d+\b/g, '').replace(/[ \t]{2,}/g, ' ').trim();
const escapeRe = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Person names found in `texts` by Muse Spark, then removed from them. Captions often end with tagged customers.
export async function removeNames(texts) {
  const found = await findPersonalNames(texts.map((text, i) => ({ id: String(i), text })), { quiet: true });
  const names = [...new Set([...found.values()].flat())].sort((a, b) => b.length - a.length);
  const re = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  return { names, texts: texts.map((t) => (re ? t.replace(re, '') : t).replace(/[ \t]{2,}/g, ' ').trim()) };
}

// ---- products ------------------------------------------------------------------------------
// Products come from post_tags for now: one per product type, shown with its best post's photo.
async function productGroups(pageId) {
  const rows = await fetchAll(() => db.from('post_tags')
    .select('post_id, product_type, product_phrase, worn_or_flat, background, offer_type, posts!inner(id, page_id, message, photo_url, engagement_score, is_boosted)')
    .eq('posts.page_id', pageId).order('post_id'));
  const groups = new Map();
  for (const r of rows) {
    const type = r.product_type?.trim().toLowerCase();
    if (!type || type === 'none' || !r.posts.photo_url) continue;
    const g = groups.get(type) || { type, posts: 0, best: null };
    g.posts++;
    const rank = (x) => (x.posts.is_boosted ? -1 : Number(x.posts.engagement_score));
    if (!g.best || rank(r) > rank(g.best)) g.best = r;
    groups.set(type, g);
  }
  return [...groups.values()].sort((a, b) => b.posts - a.posts);
}

const productView = (g) => ({
  key: g.type, label: g.type[0].toUpperCase() + g.type.slice(1), posts: g.posts,
  phrase: g.best.product_phrase, photo_url: g.best.posts.photo_url, post_id: g.best.post_id,
});

export async function listProducts(pageId) {
  return (await productGroups(pageId)).slice(0, 40).map(productView);
}

// What is actually known about the chosen product: only what the photo tags say.
function knownFacts(group) {
  const t = group.best;
  return {
    product_type: group.type,
    looks_like: t.product_phrase,
    photo_style: t.worn_or_flat,
    offer: t.offer_type && t.offer_type !== 'none' ? t.offer_type.replaceAll('_', ' ') : null,
  };
}

// ---- grounding context ---------------------------------------------------------------------
const exampleCache = new Map(); // pageId -> { at, examples, names }
const EXAMPLE_TTL_MS = 3600_000;

async function styleExamples(pageId) {
  const hit = exampleCache.get(pageId);
  if (hit && Date.now() - hit.at < EXAMPLE_TTL_MS) return hit;
  const raw = await rawExamples(pageId);
  const { names, texts } = await removeNames(raw.map(stripAliases));
  const value = { at: Date.now(), examples: texts.filter((t) => t.length >= 30), names };
  exampleCache.set(pageId, value);
  return value;
}

async function rawExamples(pageId) {
  const posts = (await fetchAll(() => db.from('posts').select('id, message, engagement_score, is_boosted')
    .eq('page_id', pageId).eq('is_boosted', false).not('photo_url', 'is', null).order('id')))
    .filter((p) => (p.message || '').trim().length >= 30);
  posts.sort((a, b) => b.engagement_score - a.engagement_score);
  const pool = posts.slice(Math.floor(posts.length * VIRAL_SKIP));
  const seen = new Set();
  const out = [];
  for (const p of pool) {
    const text = clip(scrub(p.message), 450);
    const key = text.slice(0, 40).toLowerCase();
    if (text.length < 30 || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === EXAMPLES) break;
  }
  return out;
}

function playbookContext(pb) {
  const { data, summary } = pb;
  const patterns = (data.ranked || []).slice(0, 5)
    .map((g, i) => ({ id: `P${i + 1}`, pattern: g.label, value: g.value, posts: g.posts, vs_typical: g.vs_typical }));
  const actions = (summary?.actions || []).map((text, i) => ({ id: `A${i + 1}`, text }));
  return { patterns, actions, price_question_share_pct: data.price?.share_pct ?? 0 };
}

// ---- the checks ------------------------------------------------------------------------------
const COLORS = ['red', 'blue', 'green', 'black', 'white', 'pink', 'yellow', 'purple', 'orange', 'brown', 'grey', 'gray', 'beige', 'maroon', 'navy', 'golden', 'silver', 'cream'];

// Everything the caption may not do. Returns a list of problems; an empty list means it can be shown.
export function checkCaption(caption, { allowedNumbers, knownText, priceRequired, language, forbiddenNames = [], requiredPrice = null, requiredPlaceholders = [], noOffer = false, requiredNumbers = [], stockKnown = false }) {
  const problems = [];
  const text = String(caption ?? '').trim();
  if (text.length < 20) return ['the caption is empty or far too short'];
  if (text.length > 1500) problems.push('the caption is too long (keep it under 1500 characters)');

  const withoutPlaceholders = text.replace(/\[([^\]]*)\]/g, (m, name) => {
    if (!PLACEHOLDERS.includes(name)) problems.push(`"${m}" is not an allowed placeholder (use only ${PLACEHOLDERS.map((p) => `[${p}]`).join(', ')})`);
    return ' ';
  });
  for (const n of numbersIn(withoutPlaceholders)) {
    if (!allowedNumbers.has(n)) problems.push(`the number ${n} is not in the product facts: use a placeholder such as [PRICE] or leave it out`);
  }
  const known = knownText.toLowerCase();
  if (/\b(?:XXS|XS|XL|XXL|XXXL)\b|\b[SML]\s*[,/]\s*[SML]\b/.test(withoutPlaceholders) && !/\b(?:XXS|XS|XL|XXL|XXXL|[SML])\b/.test(knownText)) {
    problems.push('sizes are not known: write [SIZES]');
  }
  for (const c of COLORS) {
    if (new RegExp(`\\b${c}\\b`, 'i').test(withoutPlaceholders) && !known.includes(c)) problems.push(`the color "${c}" is not in the product facts: write [COLORS]`);
  }
  if (/free (?:home )?delivery|ফ্রি ডেলিভারি/i.test(withoutPlaceholders) && !/free.?delivery|ফ্রি ডেলিভারি/i.test(knownText)) {
    problems.push('free delivery is not a known fact: write [DELIVERY CHARGE]');
  }
  if (/\b(?:refund|exchange|warranty|guarantee|cancell?ation|money.?back|return policy)\b|রিফান্ড|ফেরত|এক্সচেঞ্জ/i.test(withoutPlaceholders) && !/refund|exchange|warranty|guarantee|cancell?ation|money.?back|return|রিফান্ড|ফেরত|এক্সচেঞ্জ/i.test(knownText)) {
    problems.push('policies (refund, exchange, cancellation, warranty) are not known facts: leave them out');
  }
  if (/\*\*|^#{1,6}\s/m.test(text)) problems.push('plain text only: Facebook shows ** and # headings literally');
  if (/https?:\/\/|www\.|@\S|[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) problems.push('no links, e-mail addresses or @mentions');
  if (/\bcustomer\s*\d+\b/i.test(text)) problems.push('no customer names or references to comments');
  for (const n of forbiddenNames) {
    if (text.toLowerCase().includes(n.toLowerCase())) problems.push(`the name "${n}" is a person's name: remove it`);
  }
  if (priceRequired && !text.includes('[PRICE]') && ![...allowedNumbers].some((n) => numbersIn(withoutPlaceholders).has(n))) {
    problems.push('many customers ask the price, so the caption must show the price or the placeholder [PRICE]');
  }
  // new product: the owner gave the price, so it must be written out (and [PRICE] has no place); empty fields must be placeholders
  if (requiredPrice) {
    if (!numbersIn(withoutPlaceholders).has(requiredPrice)) problems.push(`the price is known: write it (${requiredPrice})`);
    if (text.includes('[PRICE]')) problems.push('the price is known, so do not use [PRICE]');
  }
  for (const name of requiredPlaceholders) {
    if (!text.includes(`[${name}]`)) problems.push(`${name.toLowerCase()} was left empty by the owner: include the placeholder [${name}]`);
  }
  if (noOffer && /\b(?:discount|sale|offer|clearance|combo|free delivery|\d+\s*%\s*off)\b|ছাড়|অফার/i.test(withoutPlaceholders)) {
    problems.push('no offer was given, so do not mention a discount, sale or offer');
  }
  // availability is the owner's to state: pre-order, limited stock, sold out are never taken from the page's style
  const claims = withoutPlaceholders.match(/\b(?:pre-?order|limited (?:stock|edition|pieces)|sold out|back in stock|last (?:piece|pair)|hurry)\b|প্রি-?অর্ডার/gi) || [];
  for (const c of new Set(claims.map((x) => x.toLowerCase()))) {
    if (!knownText.toLowerCase().includes(c)) problems.push(`"${c}" is not a known fact: leave availability claims out`);
  }
  if (!stockKnown && /\b(?:in stock|ready stock|available now)\b/i.test(withoutPlaceholders) && !/in stock|ready stock/i.test(knownText)) {
    problems.push('stock is not known: write [STOCK] instead of claiming it is in stock');
  }
  for (const n of requiredNumbers) {
    if (!numbersIn(withoutPlaceholders).has(n)) problems.push(`the owner's offer includes ${n}: mention the offer exactly as given`);
  }
  const bn = bengaliShare(text);
  if (language === 'bangla' && bn < 0.4) problems.push('write in Bangla script (বাংলা)');
  if (language !== 'bangla' && bn > 0.05) problems.push(language === 'banglish' ? 'write Bangla in English letters (Banglish), not Bangla script' : 'write in English, not Bangla script');
  return problems;
}

// A reason that cites a pattern must mention that pattern's value ("flat", "night", "discount"), otherwise it explains
// something else. Action refs (A1...) have no value to match.
function mentionsPattern(ctx, ref, text) {
  const p = ctx.patterns.find((x) => x.id === ref);
  if (!p) return true;
  const words = String(p.value).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const t = String(text).toLowerCase();
  return !words.length || words.some((w) => t.includes(w));
}

// Reasons and changes may only quote numbers that are in the playbook context.
function checkReasons(texts, ctxJson) {
  const allowed = numbersIn(ctxJson);
  for (const t of texts) for (const n of numbersIn(t)) if (!allowed.has(n)) return [`the number ${n} in an explanation is not in the playbook data`];
  return [];
}

const LANGUAGE_RULE = {
  bangla: 'Write the caption in Bangla script (বাংলা). English brand or product words may stay in English.',
  english: 'Write the caption in simple English.',
  banglish: 'Write the caption in Banglish: Bangla words written in English letters, the way Bangladeshi sellers and customers type (for example "dam inbox e jante parben"). No Bangla script.',
};

const priceRuleText = (pct, priceRequired) => (priceRequired
  ? `${pct}% of this page's comments ask the price, so the caption MUST show the price. If it is not in the known facts, write [PRICE].`
  : 'Show the price only if it is in the known facts; otherwise you may leave it out or write [PRICE].');

// ---- prompts -------------------------------------------------------------------------------
const WHY_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { ref: { type: 'string' }, reason: { type: 'string' } },
    required: ['ref', 'reason'],
    additionalProperties: false,
  },
};
const GENERATE_SCHEMA = {
  type: 'object',
  properties: { caption: { type: 'string' }, why: WHY_SCHEMA },
  required: ['caption', 'why'],
  additionalProperties: false,
};
const IMPROVE_SCHEMA = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { change: { type: 'string' }, reason: { type: 'string' }, ref: { type: 'string' } },
        required: ['change', 'reason', 'ref'],
        additionalProperties: false,
      },
    },
  },
  required: ['caption', 'changes'],
  additionalProperties: false,
};

const rulesBlock = (ctx, languageRule, priceRequired, extra = {}) => `RULES (all enforced by code; a caption that breaks one is thrown away):
- ${languageRule}
- Unknown facts are price, sizes, colors, delivery charge and stock count. Never invent them. Write exactly one of ${PLACEHOLDERS.map((p) => `[${p}]`).join(', ')} where such a fact belongs.
- Any number in the caption must appear in the known facts; if not, do not write a number at all (no discounts, percentages, sizes, prices or phone numbers you made up).
- ${extra.priceRule || priceRuleText(ctx.price_question_share_pct, priceRequired)}
${(extra.lines || []).map((l) => `- ${l}\n`).join('')}- No customer names, no @mentions, no links, nothing taken from customer comments.
- Same style as the examples: their tone, length, emoji and layout. Do not copy their facts, prices, policies (refund, exchange, cancellation) or promises. Plain text only: no ** or markdown.`;

function generatePrompt({ ctx, examples, facts, language, priceRequired, hint, problems, extra }) {
  return `You write Facebook post captions for a small seller in Bangladesh, in the seller's own voice.

THE SELLER'S BEST CAPTIONS (style only):
${examples.map((e, i) => `--- example ${i + 1}\n${e}`).join('\n')}

WHAT WORKS ON THIS PAGE (computed from the seller's data; "ref" ids are for your explanation):
${JSON.stringify({ patterns: ctx.patterns, actions: ctx.actions })}

KNOWN FACTS ABOUT THE PRODUCT (nothing else is known):
${JSON.stringify(facts)}
${hint ? `\nOWNER'S BRIEF (a suggestion from the playbook; treat it as a topic, not as facts): ${JSON.stringify(clip(hint, 300))}\n` : ''}
${rulesBlock(ctx, LANGUAGE_RULE[language], priceRequired, extra)}

Return JSON: "caption" (the post), and "why": 2 or 3 items, each with "ref" (one id from patterns or actions above, using different ids) and "reason" (one plain sentence on how this caption uses that pattern; no numbers except post counts shown above).
${problems?.length ? `\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems:\n- ${problems.join('\n- ')}\n` : ''}`;
}

function improvePrompt({ ctx, examples, facts, language, priceRequired, original, problems }) {
  return `You improve a Facebook post caption for a small seller in Bangladesh, in the seller's own voice.

THE ORIGINAL CAPTION:
${JSON.stringify(clip(original, 1200))}

THE SELLER'S BEST CAPTIONS (style only):
${examples.map((e, i) => `--- example ${i + 1}\n${e}`).join('\n')}

WHAT WORKS ON THIS PAGE (computed from the seller's data; "ref" ids are for your explanation):
${JSON.stringify({ patterns: ctx.patterns, actions: ctx.actions })}

KNOWN FACTS: everything stated in the original caption (keep every true fact and number it contains), plus ${JSON.stringify(facts)}. Nothing else is known.

Make the caption stronger using what works on this page. Keep the original's facts; add no new ones.
${rulesBlock(ctx, language ? LANGUAGE_RULE[language] : 'Write in the same language and script as the original caption.', priceRequired)}

Return JSON: "caption" (the improved post) and "changes": 2 or 3 items, each with "change" (what you changed, short), "reason" (why it should work better, one sentence, no numbers except post counts shown above) and "ref" (one id from patterns or actions above).
${problems?.length ? `\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems:\n- ${problems.join('\n- ')}\n` : ''}`;
}

// ---- running a request ---------------------------------------------------------------------
// ---- agent: tool helpers ----------------------------------------------------------------------
const median = (xs) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const statsCache = new Map(); // pageId -> { at, byType }

// How the page's earlier posts did, per product type (from the photo tags). Totals only.
async function typeStats(pageId) {
  const hit = statsCache.get(pageId);
  if (hit && Date.now() - hit.at < 600_000) return hit.byType;
  const rows = await fetchAll(() => db.from('post_tags')
    .select('product_type, worn_or_flat, price_shown, offer_type, posts!inner(page_id, engagement_score, is_boosted)')
    .eq('posts.page_id', pageId).order('post_id'));
  const groups = new Map();
  for (const r of rows) {
    const type = r.product_type?.trim().toLowerCase();
    if (!type || type === 'none' || r.posts.is_boosted) continue;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(r);
  }
  const byType = new Map([...groups].map(([type, list]) => {
    const offers = {};
    for (const r of list) if (r.offer_type && r.offer_type !== 'none') offers[r.offer_type] = (offers[r.offer_type] || 0) + 1;
    return [type, {
      product_type: type, posts: list.length, median_engagement: Math.round(median(list.map((r) => Number(r.posts.engagement_score))) * 10) / 10,
      flat_photo_pct: Math.round((list.filter((r) => r.worn_or_flat === 'flat').length / list.length) * 100),
      price_shown_pct: Math.round((list.filter((r) => r.price_shown).length / list.length) * 100),
      common_offers: Object.entries(offers).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([o]) => o.replaceAll('_', ' ')),
    }];
  }));
  statsCache.set(pageId, { at: Date.now(), byType });
  return byType;
}

async function similarProducts(pageId, query) {
  const q = String(query ?? '').toLowerCase().trim();
  const byType = await typeStats(pageId);
  const words = q.split(/\s+/).filter((w) => w.length >= 3);
  const matches = [...byType.values()]
    .filter((g) => g.product_type === q || g.product_type.includes(q) || q.includes(g.product_type) || words.some((w) => g.product_type.includes(w)))
    .sort((a, b) => (b.product_type === q) - (a.product_type === q) || b.posts - a.posts).slice(0, 4);
  return { searched_for: q || null, matches };
}

// Counts and shares only: no comment text, no names ever reach the model.
function customerQuestions(pbData) {
  const total = pbData.classified_comments || 0;
  const questions = Object.entries(pbData.intents || {}).filter(([k]) => !['other', 'praise'].includes(k))
    .map(([k, n]) => ({ question: INTENT_LABELS[k] ?? k, comments: n, share_pct: total ? Math.round((n / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.comments - a.comments);
  return { comments_read: total, price_question_share_pct: pbData.price?.share_pct ?? 0, questions };
}

const agentEnabled = () => process.env.AGENT_MODE !== 'off'; // kill switch: back to the single-call writer

// The task for the agent and the read-only tools it can call. check_draft is added by runWithChecks, so the tool,
// the final verification and the single-call fallback all run the very same checks.
function makeAgent({ pageId, kind, facts, analysis, ctx, examples, pbData, language, priceRequired, extra, hint, original, productType }) {
  if (!agentEnabled()) return undefined;
  const improving = kind === 'improve';
  const languageRule = language ? LANGUAGE_RULE[language] : 'Write in the same language and script as the original caption.';
  const answer = improving
    ? '{"caption": "...", "changes": [{"change": "...", "reason": "...", "ref": "P1"}]}  (1 to 3 changes)'
    : '{"caption": "...", "why": [{"ref": "P1", "reason": "..."}]}  (2 or 3 reasons that cite different refs)';
  const prompt = `You write Facebook posts for a small seller in Bangladesh, in the seller's own voice.

TASK: ${improving ? 'Improve the ORIGINAL CAPTION below. Keep every true fact in it, add no new facts.' : 'Write ONE new post for this product.'}
${improving ? `ORIGINAL CAPTION:\n${JSON.stringify(clip(original, 1200))}\n` : ''}
KNOWN FACTS (nothing else is known; null means unknown):
${JSON.stringify(facts)}
${hint ? `\nOWNER'S BRIEF (a topic from the playbook, not a fact): ${JSON.stringify(clip(hint, 300))}\n` : ''}
${rulesBlock(ctx, languageRule, priceRequired, extra)}

HOW TO WORK. You may make at most ${MAX_TOOL_CALLS} tool calls in total, check_draft included, so do not waste them:
1. Learn with the tools. Always call get_playbook_patterns (the ids P1, P2, A1... are what your reasons must cite) and get_best_captions. Call analyze_photo, find_similar_products and get_customer_questions when they help.
2. Write the caption.
3. Call check_draft with your caption and your ${improving ? 'changes' : 'why'}. If it fails, fix exactly the problems it lists and call check_draft again.
4. Only when check_draft has passed, reply with ONLY this JSON, using the same caption you checked: ${answer}
Never reply with a caption that has not passed check_draft.`;

  const photoFacts = () => {
    if (analysis) {
      return {
        available: true, source: 'the uploaded photos', product_type: analysis.product_type, product_phrase: analysis.product_phrase,
        suggested_name: analysis.suggested_name, colors: analysis.colors.map((c) => `${c.name} (${c.confidence})`), style: analysis.style,
        photos: analysis.photos.map((p) => ({ photo: p.index + 1, worn_or_flat: p.worn_or_flat, background: p.background, problems: p.quality_issues.map((q) => q.issue) })),
        guesses_not_facts: analysis.guesses.map((g) => `${g.field}: ${g.value}`),
      };
    }
    return facts?.looks_like
      ? { available: true, source: "your page's photo tags", product_type: facts.product_type, product_phrase: facts.looks_like, photo_style: facts.photo_style }
      : { available: false };
  };
  return {
    pageId, prompt,
    shape: (d) => typeof d?.caption === 'string' && Array.isArray(improving ? d.changes : d.why),
    impls: {
      analyze_photo: async () => photoFacts(),
      get_playbook_patterns: async () => ({ patterns: ctx.patterns, actions: ctx.actions }),
      find_similar_products: async (args) => similarProducts(pageId, args.product_type || productType || facts?.product_type),
      get_customer_questions: async () => customerQuestions(pbData),
      get_best_captions: async () => ({ captions: examples }),
    },
  };
}

async function runWithChecks({ build, schema, schemaName, validateShape, extraCheck, language, allowedNumbers, knownText, priceRequired, ctxJson, forbiddenNames, rules = {}, agent }) {
  // every check in one place: the check_draft tool, the final verification and the fallback below all call this
  const checkAll = (caption, data) => {
    const langForCheck = language || (bengaliShare(caption) > 0.4 ? 'bangla' : 'english');
    try {
      return [
        ...checkCaption(caption, { allowedNumbers, knownText, priceRequired, language: langForCheck, forbiddenNames, ...rules }),
        ...extraCheck({ ...data, caption }, ctxJson),
      ];
    } catch { return ['the reasons are not in the expected format']; }
  };
  let trace = [];
  if (agent) {
    try {
      const r = await runAgent({
        runId: randomUUID().slice(0, 8), pageId: agent.pageId, prompt: agent.prompt, shape: agent.shape,
        impls: {
          ...agent.impls,
          check_draft: async (args) => {
            const problems = checkAll(String(args.caption ?? '').trim(), { why: args.why, changes: args.changes });
            return { pass: problems.length === 0, problems };
          },
        },
        check: checkAll,
      });
      return { data: r.data, caption: r.caption, attempts: 1, trace: r.trace, mode: 'agent' };
    } catch (e) {
      console.error(JSON.stringify({ agent: true, event: 'fallback', pageId: agent.pageId, reason: e.message, status: e.status ?? null }));
      trace = [...(e.trace || []), { n: (e.trace?.length ?? 0) + 1, tool: 'fallback', ok: false, ms: 0, text: `The step-by-step writer stopped (${e.plain || 'it ran into a problem'}), so the standard writer finished the job.` }];
    }
  }
  let problems = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { data } = await completeJSON('post_generation', {
      messages: [{ role: 'user', content: build(problems) }],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, schema } },
    }, { validate: validateShape });
    const caption = String(data.caption || '').trim();
    const langForCheck = language || (bengaliShare(caption) > 0.4 ? 'bangla' : 'english');
    problems = [
      ...checkCaption(caption, { allowedNumbers, knownText, priceRequired, language: langForCheck, forbiddenNames, ...rules }),
      ...extraCheck(data, ctxJson),
    ];
    if (!problems.length) return { data, caption, attempts: attempt, trace, mode: agent ? 'fallback' : 'single' };
    console.error(`generation rejected (attempt ${attempt}/${MAX_ATTEMPTS}):`, problems.join(' | '));
  }
  throw fail(`Could not write a caption that follows the rules after ${MAX_ATTEMPTS} tries. Please try again.`, 422);
}

const usedPatterns = (ctx, refs) => [...new Set(refs)].map((r) => ctx.patterns.find((p) => p.id === r)).filter(Boolean);

async function loadContext(pageId) {
  const pb = await latestPlaybook(pageId);
  if (pb.status !== 'ready') throw fail('Your playbook is not ready yet. Create works once the analysis has finished.', 409);
  const ctx = playbookContext(pb);
  if (!ctx.patterns.length && !ctx.actions.length) throw fail('The playbook has no patterns to write from yet.', 409);
  const { examples, names } = await styleExamples(pageId);
  if (!examples.length) throw fail('This page has no captions to learn the style from yet.', 409);
  return { ctx, examples, names, pbData: pb.data, priceRequired: ctx.price_question_share_pct >= PRICE_ALERT_PCT, ctxJson: JSON.stringify(ctx) };
}

const checkWhy = (data, ctxJson, ctx) => {
  const ids = new Set([...ctx.patterns, ...ctx.actions].map((x) => x.id));
  const items = data.why || [];
  if (items.length < 2 || items.length > 3) return [`"why" needs 2 or 3 reasons, you gave ${items.length}`];
  if (items.some((w) => !ids.has(w.ref) || !String(w.reason || '').trim())) return ['every "why" item needs a ref from the patterns or actions lists and a reason'];
  if (new Set(items.map((w) => w.ref)).size < 2) return ['the reasons must cite at least two different refs'];
  const off = items.find((w) => !mentionsPattern(ctx, w.ref, w.reason));
  if (off) return [`the reason for ${off.ref} must talk about "${ctx.patterns.find((p) => p.id === off.ref).value}", the pattern it cites`];
  return checkReasons(items.map((w) => w.reason), ctxJson);
};

// ---- generate ------------------------------------------------------------------------------
export async function generatePost(pageId, { productKey, description, language, hint }) {
  if (!LANGUAGES.includes(language)) throw fail(`language must be one of ${LANGUAGES.join(', ')}`);
  const text = clip(String(description ?? '').trim(), 600);
  if (!productKey && !text) throw fail('Pick a product or describe what you are selling.');
  const { ctx, examples, names, pbData, priceRequired, ctxJson } = await loadContext(pageId);

  let facts;
  let product = null;
  let productType = null;
  if (productKey) {
    const group = (await productGroups(pageId)).find((g) => g.type === String(productKey).toLowerCase());
    if (!group) throw fail('That product was not found on this page.', 404);
    facts = knownFacts(group);
    productType = group.type;
    product = productView(group);
    if (text) facts.owner_notes = text;
  } else {
    facts = { description_from_owner: text };
  }
  const factsJson = JSON.stringify(facts);
  const { data, caption, attempts, trace, mode } = await runWithChecks({
    agent: makeAgent({ pageId, kind: 'generate', facts, analysis: null, ctx, examples, pbData, language, priceRequired, hint, productType }),
    build: (problems) => generatePrompt({ ctx, examples, facts, language, priceRequired, hint, problems }),
    schema: GENERATE_SCHEMA, schemaName: 'post_caption',
    validateShape: (d) => { if (typeof d?.caption !== 'string' || !Array.isArray(d.why)) throw new Error('answer is missing caption or why'); },
    extraCheck: (d, json) => checkWhy(d, json, ctx),
    language, allowedNumbers: numbersIn(factsJson), knownText: factsJson, priceRequired, ctxJson, forbiddenNames: names,
  });
  return {
    kind: 'generate', caption, language, product, attempts, trace, agent_mode: mode,
    why: data.why.map((w) => ({ ref: w.ref, reason: w.reason, pattern: ctx.patterns.find((p) => p.id === w.ref) || null, action: ctx.actions.find((a) => a.id === w.ref)?.text || null })),
    patterns_used: usedPatterns(ctx, data.why.map((w) => w.ref)),
    placeholders: [...new Set([...caption.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]))],
    photo_url: product?.photo_url ?? null, source_post_id: product?.post_id ?? null,
  };
}

// ---- generate for a NEW product (uploaded photos + the owner's details form) ---------------------------------
const clean = (v, n) => clip(String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim(), n);
const splitList = (v) => clean(v, 120).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);

// The owner's form, checked and tidied. Only the price is required.
export function parseProductForm(form = {}, { priceOptional = false } = {}) {
  const priceText = toAscii(form.price).replace(/[,\s৳]|tk\.?|taka|bdt/gi, '');
  const price = priceText === '' && priceOptional ? null : Number(priceText);
  if (price !== null && (!priceText || !Number.isFinite(price) || price <= 0)) throw fail('Enter the price, for example 950.');
  const stockText = toAscii(form.stock).replace(/[,\s]/g, '');
  const stock = stockText === '' ? null : Math.floor(Number(stockText));
  if (stock !== null && (!Number.isFinite(stock) || stock < 0)) throw fail('Stock must be a number, or leave it empty.');
  return {
    name: clean(form.name, 80) || null, price, sizes: splitList(form.sizes), colors: splitList(form.colors),
    stock, offer: clean(form.offer, 100) || null,
  };
}

function newProductFacts(f, analysis, availability = null) {
  return {
    product_name: f.name, product_type: analysis?.product_type || null, looks_like: analysis?.product_phrase || null,
    price: f.price == null ? null : { amount: f.price, currency: 'Bangladeshi taka (Tk or ৳)' }, availability,
    sizes: f.sizes.length ? f.sizes : null, colors: f.colors.length ? f.colors : null, stock: f.stock, offer: f.offer,
  };
}

export async function generateNewProduct(pageId, { form, analysis, language, hint, priceOptional = false, availability = null }) {
  if (!LANGUAGES.includes(language)) throw fail(`language must be one of ${LANGUAGES.join(', ')}`);
  const f = parseProductForm(form, { priceOptional });
  const { ctx, examples, names, pbData, priceRequired: priceAsked, ctxJson } = await loadContext(pageId);
  const facts = newProductFacts(f, analysis, availability);
  const factsJson = JSON.stringify(facts);
  const missing = [!f.sizes.length && 'SIZES', !f.colors.length && 'COLORS', f.stock === null && 'STOCK'].filter(Boolean);
  const priceRequired = f.price == null ? priceAsked : false; // no stated price: the 20% rule applies, as for any post
  const extra = {
    ...(f.price != null && { priceRule: `The price is KNOWN and must appear in the caption: ${f.price} taka. Write the number exactly (for example "Tk ${f.price}" or "${f.price} taka"). Do not write [PRICE].` }),
    lines: [
      'Facts marked null are unknown. Never guess them.',
      ...(missing.length ? [`These were left empty by the owner, so the caption must contain these exact placeholders: ${missing.map((m) => `[${m}]`).join(', ')}.`] : []),
      ...(f.offer ? [`The owner's offer is ${JSON.stringify(f.offer)}: mention it exactly as given, including its numbers.`] : ['No offer was given: do not mention any discount, sale or offer.']),
      'Do not claim availability (pre-order, limited stock, sold out, in stock) unless it is in the known facts.',
    ],
  };
  const { data, caption, attempts, trace, mode } = await runWithChecks({
    agent: makeAgent({ pageId, kind: 'new_product', facts, analysis, ctx, examples, pbData, language, priceRequired, extra, hint }),
    build: (problems) => generatePrompt({ ctx, examples, facts, language, priceRequired, hint, problems, extra }),
    schema: GENERATE_SCHEMA, schemaName: 'post_caption',
    validateShape: (d) => { if (typeof d?.caption !== 'string' || !Array.isArray(d.why)) throw new Error('answer is missing caption or why'); },
    extraCheck: (d, json) => checkWhy(d, json, ctx),
    language, allowedNumbers: numbersIn(factsJson), knownText: factsJson, priceRequired, ctxJson, forbiddenNames: names,
    rules: { requiredPrice: f.price == null ? null : String(f.price), requiredPlaceholders: missing, noOffer: !f.offer, stockKnown: f.stock !== null, requiredNumbers: f.offer ? [...numbersIn(f.offer)] : [] },
  });
  return {
    kind: 'generate', caption, language, attempts, trace, agent_mode: mode, product: { name: f.name, ...f },
    why: data.why.map((w) => ({ ref: w.ref, reason: w.reason, pattern: ctx.patterns.find((p) => p.id === w.ref) || null, action: ctx.actions.find((a) => a.id === w.ref)?.text || null })),
    patterns_used: usedPatterns(ctx, data.why.map((w) => w.ref)),
    placeholders: [...new Set([...caption.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]))],
    photo_url: null, source_post_id: null,
  };
}

// ---- generate from a product in the catalog (the "existing product" option) -------------------------------------
// The catalog holds what the owner has confirmed, so a known price must be written and unknown facts become
// placeholders, exactly as for a new product.
export async function generateFromCatalog(pageId, { productId, language, hint }) {
  const product = await getCatalogProduct(pageId, productId);
  if (product.status === 'sold_out') throw fail('This product is marked sold out. Restock it before writing a post about it.', 409);
  // a "few left" post may say so only when the stock count is known and low
  const low = product.stock != null && product.stock > 0 && product.stock <= await lowStockThreshold(pageId);
  const availability = low ? `limited stock: only ${product.stock} left` : product.status === 'pre_order' ? 'pre-order (the caption may say so)' : null;
  const result = await generateNewProduct(pageId, {
    form: { name: product.name, price: product.price ?? '', sizes: product.sizes.join(', '), colors: product.colors.join(', '), stock: product.stock ?? '', offer: product.offer ?? '' },
    analysis: { product_type: product.type, product_phrase: product.phrase || product.name },
    language, hint, priceOptional: true, availability,
  });
  const stored = product.photo_ref ?? null;
  return { ...result, product: { id: product.id, name: product.name, price: product.price, status: product.status }, photo_url: product.thumbnail_url, photo_store: stored, source_post_id: product.source_post_id ?? null };
}

// ---- improve -------------------------------------------------------------------------------
export async function improvePost(pageId, { postId, caption, language }) {
  if (language && !LANGUAGES.includes(language)) throw fail(`language must be one of ${LANGUAGES.join(', ')}`);
  let original = clip(String(caption ?? '').trim(), 1500);
  let post = null;
  if (postId) {
    const { data, error } = await db.from('posts').select('id, message, photo_url').eq('id', postId).eq('page_id', pageId).maybeSingle();
    if (error) throw error;
    if (!data) throw fail('Post not found on this page.', 404);
    post = data;
    original = clip(scrub(data.message), 1500);
  }
  original = stripAliases(original);
  if (original.length < 10) throw fail('That post has no caption to improve.');
  const { ctx, examples, names: exampleNames, pbData, priceRequired, ctxJson } = await loadContext(pageId);
  // names tagged in the original caption are not facts to keep: they are removed before the model sees it
  const cleaned = await removeNames([original]);
  original = cleaned.texts[0];
  const forbiddenNames = [...new Set([...exampleNames, ...cleaned.names])];

  let facts = {};
  if (post) {
    const { data: tag } = await db.from('post_tags').select('product_type, product_phrase, worn_or_flat, offer_type').eq('post_id', post.id).maybeSingle();
    if (tag) facts = { product_type: tag.product_type, looks_like: tag.product_phrase, photo_style: tag.worn_or_flat };
  }
  const factsText = `${JSON.stringify(facts)} ${original}`; // numbers, sizes and colors already in the caption are known facts
  const lang = language || null;
  const { data, caption: improved, attempts, trace, mode } = await runWithChecks({
    agent: makeAgent({ pageId, kind: 'improve', facts, analysis: null, ctx, examples, pbData, language: lang, priceRequired, original }),
    build: (problems) => improvePrompt({ ctx, examples, facts, language: lang, priceRequired, original, problems }),
    schema: IMPROVE_SCHEMA, schemaName: 'improved_caption',
    validateShape: (d) => { if (typeof d?.caption !== 'string' || !Array.isArray(d.changes)) throw new Error('answer is missing caption or changes'); },
    extraCheck: (d, json) => {
      const ids = new Set([...ctx.patterns, ...ctx.actions].map((x) => x.id));
      if (d.changes.length < 1 || d.changes.length > 3) return ['"changes" needs 1 to 3 items'];
      if (d.changes.some((c) => !ids.has(c.ref) || !c.change?.trim() || !c.reason?.trim())) return ['every change needs a ref from the patterns or actions lists, a change and a reason'];
      if (d.caption.trim() === original.trim()) return ['the caption is unchanged: improve it'];
      const off = d.changes.find((c) => !mentionsPattern(ctx, c.ref, `${c.change} ${c.reason}`));
      if (off) return [`the change for ${off.ref} must talk about "${ctx.patterns.find((p) => p.id === off.ref).value}", the pattern it cites`];
      return checkReasons(d.changes.flatMap((c) => [c.change, c.reason]), json);
    },
    language: lang, allowedNumbers: numbersIn(factsText), knownText: factsText, priceRequired, ctxJson, forbiddenNames,
  });
  return {
    kind: 'improve', caption: improved, language: lang || detectLanguage(improved), attempts, trace, agent_mode: mode,
    original_caption: original,
    changes: data.changes.map((c) => ({ change: c.change, reason: c.reason, ref: c.ref, pattern: ctx.patterns.find((p) => p.id === c.ref) || null })),
    patterns_used: usedPatterns(ctx, data.changes.map((c) => c.ref)),
    placeholders: [...new Set([...improved.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]))],
    photo_url: post?.photo_url ?? null, source_post_id: post?.id ?? null,
  };
}

// ---- drafts ----------------------------------------------------------------------------------
// post_drafts (migration 002) keeps the structured details in its `why` column.
export async function saveDraft(pageId, result) {
  const { caption, language, photo_url, photo_store, source_post_id, ...details } = result;
  const { data, error } = await db.from('post_drafts').insert({
    page_id: pageId, source_post_id, caption, language, photo_url: photo_store ?? photo_url, why: details,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function listDrafts(pageId) {
  const { data, error } = await db.from('post_drafts').select('*').eq('page_id', pageId)
    .eq('status', 'draft').order('created_at', { ascending: false }).limit(20);
  if (error) throw error;
  return Promise.all(data.map(async (d) => ({ ...d, photo_url: await showableUrl(d.photo_url), branded_url: await signedUrl(d.branded_url) })));
}

export async function updateDraft(pageId, draftId, caption) {
  const text = String(caption ?? '').trim();
  if (text.length < 1 || text.length > 3000) throw fail('The caption must be between 1 and 3000 characters.');
  const { data, error } = await db.from('post_drafts').update({ caption: text, updated_at: new Date().toISOString() })
    .eq('id', draftId).eq('page_id', pageId).select().maybeSingle();
  if (error) throw error;
  if (!data) throw fail('Draft not found.', 404);
  return data;
}
