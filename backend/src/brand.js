import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db } from './db.js';
import { meta, MODELS } from './meta.js';
import { clip, completeJSON } from './ai.js';
import { hasColumns } from './schema.js';

// Brand settings (shop name, color, logo) and logo making. A logo is stored as a transparent PNG; muse-image-1.0
// can only make logos (it never touches product photos) and has no transparent-background option, so the white
// around a generated logo is removed here.
export const BUCKET = 'brand-assets';
const REF = `storage://${BUCKET}/`;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const DEFAULT_COLOR = '#12694A';
const LOGO_PX = 1000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

let bucketReady = null;
function ensureBucket() {
  bucketReady ??= (async () => {
    const { data, error } = await db.storage.listBuckets();
    if (error) throw error;
    if (data.some((b) => b.name === BUCKET)) return;
    const { error: err } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 5 * 1024 * 1024, allowedMimeTypes: ['image/png', 'image/jpeg'] });
    if (err && !/already exists/i.test(err.message)) throw err;
  })().catch((e) => { bucketReady = null; throw e; });
  return bucketReady;
}

export const isRef = (v) => typeof v === 'string' && v.startsWith(REF);
export async function putFile(pageId, name, buffer, contentType) {
  await ensureBucket();
  const path = `${pageId}/${name}`;
  const { error } = await db.storage.from(BUCKET).upload(path, buffer, { contentType, upsert: false });
  if (error) throw error;
  return `${REF}${path}`;
}
export async function getFile(ref) {
  const { data, error } = await db.storage.from(BUCKET).download(ref.slice(REF.length));
  if (error || !data) throw fail('That image is no longer stored.', 404);
  return Buffer.from(await data.arrayBuffer());
}
export async function signedUrl(ref, seconds = 3600) {
  if (!isRef(ref)) return ref ?? null;
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(ref.slice(REF.length), seconds);
  return error ? null : data.signedUrl;
}

// ---- turning an image into a transparent logo ---------------------------------------------------------------
// Ink strength of a pixel on white: 0 for white, up to 255 for black.
async function keyOutWhite(buffer, { color = null } = {}) {
  const { data, info } = await sharp(buffer).flatten({ background: '#ffffff' }).resize({ width: LOGO_PX, height: LOGO_PX, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ink = new Uint8Array(info.width * info.height);
  const hist = new Uint32Array(256);
  for (let i = 0; i < ink.length; i++) { const d = 255 - Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); ink[i] = d; hist[d]++; }
  let seen = 0; let strong = 255;
  for (let d = 255; d >= 0; d--) { seen += hist[d]; if (seen >= ink.length * 0.01) { strong = d; break; } } // the 99th percentile counts as "full ink"
  if (strong < 40) throw fail('That image looks blank, so there is no logo in it.');
  const rgb = color && /^#?[0-9a-f]{6}$/i.test(color) ? [0, 2, 4].map((i) => parseInt(color.replace('#', '').slice(i, i + 2), 16)) : null;
  for (let i = 0; i < ink.length; i++) {
    const a = Math.min(1, Math.max(0, (ink[i] - 12) / (strong - 12)));
    if (rgb) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; }
    else if (a > 0) for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round((data[i * 4 + c] - 255 * (1 - a)) / a))); // keep the true color, not a white-washed edge
    data[i * 4 + 3] = Math.round(a * 255);
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

// Crop away transparent margins (a little air is kept).
async function trimToInk(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width; let y0 = info.height; let x1 = 0; let y1 = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 <= x0 || y1 <= y0) throw fail('That image looks blank, so there is no logo in it.');
  const air = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02);
  x0 = Math.max(0, x0 - air); y0 = Math.max(0, y0 - air); x1 = Math.min(info.width - 1, x1 + air); y1 = Math.min(info.height - 1, y1 + air);
  return sharp(png).extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }).png().toBuffer();
}

// An SVG is rasterised by a library that must never be able to fetch anything: reject anything that could.
const UNSAFE_SVG = /<!ENTITY|<!DOCTYPE[^>]*\[|<script|<foreignObject|<image|<use[^>]+href=["'](?!#)|@import|(?:xlink:)?href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i;

export async function logoFromUpload(buffer, mime) {
  if (!buffer?.length) throw fail('That file is empty.');
  if (buffer.length > MAX_LOGO_BYTES) throw fail('The logo must be 2 MB or smaller.');
  let png;
  try {
    if (/svg/.test(mime) || /^\s*(<\?xml|<svg)/i.test(buffer.subarray(0, 200).toString())) {
      if (UNSAFE_SVG.test(buffer.toString('utf8'))) throw fail('That SVG contains things we do not allow (scripts or links to other files). Export a plain SVG or use a PNG.');
      png = await sharp(buffer, { density: 300, limitInputPixels: 50e6 }).resize({ width: LOGO_PX, height: LOGO_PX, fit: 'inside' }).ensureAlpha().png().toBuffer();
    } else {
      png = await sharp(buffer, { limitInputPixels: 50e6 }).resize({ width: LOGO_PX, height: LOGO_PX, fit: 'inside', withoutEnlargement: true }).ensureAlpha().png().toBuffer();
    }
  } catch (e) {
    if (e.status) throw e;
    throw fail('We could not read that file as a logo. Use a PNG or an SVG.');
  }
  // a logo with no transparency (a white box around it) gets its white removed, keeping its colors
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent++;
  if (transparent / (info.width * info.height) < 0.01) png = await keyOutWhite(png);
  return trimToInk(png);
}

// ---- generating a logo (muse-image-1.0) ---------------------------------------------------------------------------
const STYLES = {
  wordmark: (name, color) => `A clean, modern logo for a small fashion shop. A simple wordmark: only the words "${name}" in elegant, well-spaced lettering, flat vector style, one color (${color}), on a plain pure white background, centered with generous empty space around it. No mockup, no shadow, no gradient, no extra words, no tagline.`,
  icon: (name, color) => `A clean, modern logo for a small fashion shop: a small simple icon with the words "${name}" written next to or under it, flat vector style, one color (${color}), on a plain pure white background, centered with generous empty space around it. No mockup, no shadow, no gradient, no extra words, no tagline.`,
};
const CHECK_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// An image model can misspell the name it was asked to write, so every logo is read back by Muse Spark's vision and
// only those that spell the shop name exactly count as checked.
async function readText(png) {
  const onWhite = await sharp(png).flatten({ background: '#ffffff' }).resize({ width: 600, height: 600, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const { data } = await completeJSON('logo_check', {
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'Read every word written in this logo image, exactly as spelled, letter by letter. Return JSON {"text": "..."} with the words only (empty if there are none).' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${onWhite.toString('base64')}` } },
    ] }],
    response_format: { type: 'json_schema', json_schema: { name: 'logo_text', schema: CHECK_SCHEMA } },
  }, { validate: (d) => { if (typeof d?.text !== 'string') throw new Error('answer has no text'); } });
  return data.text;
}

export async function generateLogos({ shopName, style = 'wordmark', color = DEFAULT_COLOR, rounds = 2 }) {
  const name = String(shopName ?? '').replace(/[\u0000-\u001f"]/g, ' ').trim();
  if (name.length < 2 || name.length > 40) throw fail('Type the shop name first (2 to 40 characters).');
  if (!STYLES[style]) throw fail('style must be "wordmark" or "icon".');
  const good = [];
  const rest = [];
  for (let round = 0; round < rounds && good.length < 3; round++) {
    const res = await meta.images.generate({ model: MODELS.image, prompt: STYLES[style](name, color), n: 3, size: '1024x1024', output_format: 'png' });
    for (const item of res.data ?? []) {
      if (!item.b64_json) continue;
      try {
        const png = await trimToInk(await keyOutWhite(Buffer.from(item.b64_json, 'base64'), { color }));
        const read = await readText(png).catch(() => null);
        const option = { id: randomUUID(), png, read, verified: read != null && norm(read) === norm(name) };
        (option.verified ? good : rest).push(option);
      } catch (e) { console.error('generated logo skipped:', e.message); }
    }
  }
  const options = [...good, ...rest].slice(0, 3);
  if (!options.length) throw fail('No usable logo came back. Try again.', 502);
  return options;
}

// ---- brand settings --------------------------------------------------------------------------------------------------
const ready = () => hasColumns('pages', ['brand']);

export async function getBrand(pageId) {
  if (!(await ready())) return { shop_name: null, color: DEFAULT_COLOR, logo: null, ready: false };
  const { data } = await db.from('pages').select('name, brand').eq('id', pageId).maybeSingle();
  const b = data?.brand ?? {};
  return { shop_name: b.shop_name ?? data?.name ?? null, color: b.color ?? DEFAULT_COLOR, logo: b.logo ?? null, ready: true };
}

export async function brandView(pageId) {
  const b = await getBrand(pageId);
  return { ...b, logo_url: await signedUrl(b.logo), logo: undefined, has_logo: !!b.logo };
}

export async function saveBrand(pageId, { shop_name, color }) {
  if (!(await ready())) throw fail('Brand settings need db/009_brand.sql to be run first.', 409);
  const current = (await db.from('pages').select('brand').eq('id', pageId).single()).data?.brand ?? {};
  const next = { ...current };
  if (shop_name !== undefined) {
    const n = clip(String(shop_name).replace(/[\u0000-\u001f]/g, ' ').trim(), 40);
    if (!n) throw fail('The shop name cannot be empty.');
    next.shop_name = n;
  }
  if (color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(color))) throw fail('The brand color must look like #12694A.');
    next.color = String(color).toLowerCase();
  }
  const { error } = await db.from('pages').update({ brand: next }).eq('id', pageId);
  if (error) throw error;
  return brandView(pageId);
}

export async function saveLogo(pageId, png) {
  if (!(await ready())) throw fail('Brand settings need db/009_brand.sql to be run first.', 409);
  const ref = await putFile(pageId, `logo-${randomUUID()}.png`, png, 'image/png');
  const current = (await db.from('pages').select('brand').eq('id', pageId).single()).data?.brand ?? {};
  const { error } = await db.from('pages').update({ brand: { ...current, logo: ref } }).eq('id', pageId);
  if (error) throw error;
  return brandView(pageId);
}

export async function loadLogo(pageId) {
  const b = await getBrand(pageId);
  return b.logo ? getFile(b.logo) : null;
}

// A logo the owner picked or the demo visitor holds in their tab, sent back as a data URL: checked before it is used.
export async function logoFromDataUrl(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw fail('The logo must be a PNG.');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_LOGO_BYTES) throw fail('The logo must be 2 MB or smaller.');
  try { await sharp(buf).metadata(); } catch { throw fail('We could not read that logo.'); }
  return buf;
}
