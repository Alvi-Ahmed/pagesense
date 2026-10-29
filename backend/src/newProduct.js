import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { backgroundStyle, latestPlaybook } from './playbook.js';
import { cleanPhoto, loadStored, refFor, toDataUrl } from './photos.js';
import { parseProductForm } from './generate.js';
import { hasColumns } from './schema.js';

const MAX_PHOTOS = 5;
const MIN_SIDE_PX = 700; // below this the photo is too small to look good on a phone
const MAX_LIFT = 10; // same sanity limit as the playbook's headline
const TIP_MIN_POSTS = 10; // a pattern needs this many posts behind both sides to become a tip
const TIP_MIN_GAP = 1.25; // and the better style must beat yours by at least 25%
const MAX_TIPS = 2;
const ISSUES = ['blurry', 'too_dark', 'too_bright', 'cluttered_background', 'product_cut_off', 'product_too_small', 'glare', 'other'];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

// ---- what the model sees in the photos -------------------------------------------------------
const SCHEMA = {
  type: 'object',
  properties: {
    product_type: { type: 'string' },
    product_phrase: { type: 'string' },
    suggested_name: { type: 'string' },
    colors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
        required: ['name', 'confidence'], additionalProperties: false,
      },
    },
    style: { type: 'string' },
    guesses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, value: { type: 'string' }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['field', 'value', 'confidence'], additionalProperties: false,
      },
    },
    photos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          worn_or_flat: { type: 'string', enum: ['worn', 'flat', 'unknown'] },
          background: { type: 'string' },
          quality_issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: { issue: { type: 'string', enum: ISSUES }, detail: { type: 'string' } },
              required: ['issue', 'detail'], additionalProperties: false,
            },
          },
        },
        required: ['index', 'worn_or_flat', 'background', 'quality_issues'], additionalProperties: false,
      },
    },
  },
  required: ['product_type', 'product_phrase', 'suggested_name', 'colors', 'style', 'guesses', 'photos'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You look at product photos from a small seller in Bangladesh who is about to post ONE new product. All photos show the same product.
Return:
- product_type: one or two lowercase English words, e.g. "sneakers", "handbag", "saree", "panjabi"
- product_phrase: a concrete English noun phrase for what you can SEE, e.g. "white leather-look sneakers with a red sole"
- suggested_name: a short product name a seller would use (2 to 5 words)
- colors: the main visible colors, each with a confidence (high, medium or low)
- style: a few words, e.g. "casual", "party wear", "sporty"
- guesses: things you CANNOT see for certain: material (cotton? leather?), brand, pattern name, fit. Each is {field, value, confidence}. Only include a guess if there is a real hint. Anything not clearly printed in the photo has confidence "low". Never state a material or brand as fact: do NOT put a material or brand word in product_phrase or suggested_name.
- photos: one entry per photo, in order, with "index" starting at 0: worn_or_flat ("worn" if on a person or mannequin, "flat" if laid out or on a surface, else "unknown"), background (a few words), and quality_issues: list only REAL problems as {issue, detail} where issue is one of ${ISSUES.join(', ')}.`;

// Material and brand are guesses: they may never leak into the phrase or the name as if known.
function withoutGuessWords(text, guesses) {
  let out = text;
  for (const g of guesses) {
    if (!['material', 'brand'].includes(g.field.toLowerCase()) || g.value.length < 3) continue;
    out = out.replace(new RegExp(`\\b${g.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
  }
  return out;
}

function normalise(raw, shots) {
  const guesses = (raw.guesses || [])
    .filter((g) => g.value?.trim() && !/^(?:no|not|none|unknown|n\/a|unclear|unsure|cannot)\b/i.test(g.value.trim()) && !/\b(?:not visible|no visible|not clearly|no brand)\b/i.test(g.value)) // "no brand visible" is not a guess
    .map((g) => ({ field: g.field.trim().toLowerCase(), value: g.value.trim(), confidence: 'low' })); // never more than a guess
  const photos = shots.map((shot, i) => {
    const p = (raw.photos || []).find((x) => x.index === i) || (raw.photos || [])[i] || {};
    const issues = (p.quality_issues || []).filter((q) => ISSUES.includes(q.issue)).map((q) => ({ issue: q.issue, detail: clip(q.detail, 120) }));
    if (Math.min(shot.width, shot.height) < MIN_SIDE_PX) issues.push({ issue: 'low_resolution', detail: `only ${shot.width}×${shot.height} pixels` });
    const background = clip(p.background || '', 60);
    return {
      index: i, worn_or_flat: ['worn', 'flat'].includes(p.worn_or_flat) ? p.worn_or_flat : 'unknown',
      background, background_style: backgroundStyle(background) || 'other', quality_issues: issues,
    };
  });
  return {
    product_type: clip(raw.product_type, 40).toLowerCase().trim(),
    product_phrase: withoutGuessWords(clip(raw.product_phrase, 120), guesses),
    suggested_name: withoutGuessWords(clip(raw.suggested_name, 80), guesses),
    colors: (raw.colors || []).slice(0, 5).map((c) => ({ name: clip(c.name, 30).toLowerCase(), confidence: c.confidence })),
    style: clip(raw.style, 60), guesses, photos,
  };
}

// images: [{ upload_id }] (stored photos) or [{ data }] (base64, demo only: nothing is stored).
export async function analyzePhotos(pageId, images, { demo = false } = {}) {
  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_PHOTOS) throw bad(`Send between 1 and ${MAX_PHOTOS} photos.`);
  const shots = [];
  for (const img of images) {
    let buffer;
    if (img.upload_id) buffer = await loadStored(pageId, img.upload_id);
    else if (img.data && demo) buffer = Buffer.from(String(img.data).replace(/^data:[^,]*,/, ''), 'base64');
    else throw bad('Upload the photos first.');
    shots.push(await cleanPhoto(buffer));
  }
  const content = [{ type: 'text', text: INSTRUCTIONS }];
  shots.forEach((s, i) => {
    content.push({ type: 'text', text: `photo ${i}` });
    content.push({ type: 'image_url', image_url: { url: toDataUrl(s.analysis) } });
  });
  const { data } = await completeJSON('photo_analysis', {
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_schema', json_schema: { name: 'photo_analysis', schema: SCHEMA } },
  }, { validate: (d) => { if (typeof d?.product_type !== 'string' || !Array.isArray(d.photos)) throw new Error('answer is missing product_type or photos'); } });

  const analysis = normalise(data, shots);
  const pb = await latestPlaybook(pageId);
  return { analysis, tips: pb.status === 'ready' ? photoTips(pb.data, analysis.photos) : [] };
}

// ---- tips from the playbook, computed in code ----------------------------------------------------
// Only the two photo dimensions, only groups that passed the playbook's sample-size and sanity rules
// (10+ posts, at most 10x typical), at most 2 tips. Each tip carries its numbers and post counts.
const TIP_DIMENSIONS = {
  worn_or_flat: { label: 'Worn or flat', photoValue: (p) => (p.worn_or_flat === 'unknown' ? null : p.worn_or_flat), advice: (v) => `Add a ${v} shot of this product too.` },
  background_style: { label: 'Background', photoValue: (p) => (p.background_style === 'other' ? null : p.background_style), advice: (v) => `Try a ${v} background.` },
};

export function photoTips(playbookData, photos) {
  const tips = [];
  for (const [key, cfg] of Object.entries(TIP_DIMENSIONS)) {
    const dim = (playbookData.dimensions || []).find((d) => d.key === key);
    if (!dim) continue;
    const trusted = dim.groups.filter((g) => g.posts >= TIP_MIN_POSTS && g.lift != null && g.lift <= MAX_LIFT);
    const mine = trusted.filter((g) => photos.some((p) => cfg.photoValue(p) === g.value));
    if (!mine.length) continue; // this photo's style has no trustworthy numbers behind it
    const yours = mine.reduce((a, b) => (b.median_engagement > a.median_engagement ? b : a));
    const better = trusted.reduce((a, b) => (b.median_engagement > a.median_engagement ? b : a));
    if (better.value === yours.value || !yours.median_engagement || better.median_engagement / yours.median_engagement < TIP_MIN_GAP) continue;
    tips.push({
      dimension: key, label: cfg.label, gap: better.median_engagement / yours.median_engagement,
      text: `Your ${yours.value} photos get a median of ${yours.median_engagement} engagement (${yours.posts} posts); ${better.value} photos get ${better.median_engagement} (${better.posts} posts). ${cfg.advice(better.value)}`,
      yours: { value: yours.value, posts: yours.posts, median_engagement: yours.median_engagement },
      better: { value: better.value, posts: better.posts, median_engagement: better.median_engagement },
    });
  }
  return tips.sort((a, b) => b.gap - a.gap).slice(0, MAX_TIPS).map(({ gap, ...tip }) => tip); // eslint-disable-line no-unused-vars
}

// ---- save: product into the catalog, draft linked to it -------------------------------------------
export async function saveNewProduct(pageId, { form, analysis, upload_ids: uploadIds, draft }) {
  const f = parseProductForm(form);
  if (!Array.isArray(uploadIds) || !uploadIds.length) throw bad('Upload at least one photo first.');
  const caption = String(draft?.caption ?? '').trim();
  if (caption.length < 1 || caption.length > 3000) throw bad('The caption must be between 1 and 3000 characters.');

  const paths = uploadIds.map((id) => {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw bad('Unknown photo.');
    return `${pageId}/${id}.jpg`;
  });
  const photoRef = refFor(paths[0]);
  const name = f.name || analysis?.suggested_name || analysis?.product_type || 'New product';
  const base = {
    page_id: pageId, name, product_type: analysis?.product_type || null, price: f.price, sizes: f.sizes, colors: f.colors,
    photo_url: photoRef, status: 'in_stock',
  };
  const extras = { stock: f.stock, offer: f.offer, photo_paths: paths, analysis: analysis ?? null, source: 'upload' };
  const hasExtras = await hasColumns('products', Object.keys(extras));
  const { data: product, error } = await db.from('products').insert(hasExtras ? { ...base, ...extras } : base).select().single();
  if (error) throw error;

  const linked = await hasColumns('post_drafts', ['product_id']);
  const { id, caption: _c, language, why, patterns_used, placeholders } = { ...draft, caption }; // eslint-disable-line no-unused-vars
  const details = {
    kind: 'generate', why: why || [], patterns_used: patterns_used || [], placeholders: placeholders || [], product_id: product.id,
    product: { name, ...f, ...(hasExtras ? {} : { photo_paths: paths, analysis: analysis ?? null }) }, // keeps what 005 would have stored
  };
  const { data: saved, error: err } = await db.from('post_drafts').insert({
    page_id: pageId, caption, language: language || 'banglish', photo_url: photoRef, why: details, ...(linked && { product_id: product.id }),
  }).select().single();
  if (err) throw err;
  return { product, draft: saved, columns_missing: !hasExtras || !linked };
}
