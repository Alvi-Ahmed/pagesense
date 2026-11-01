import 'dotenv/config';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import opentype from 'opentype.js';
import { MODELS } from './meta.js';
import { completeJSON } from './ai.js';

// Item 10: put the shop's logo (and a price badge) on a product photo. The product's pixels are never touched: the
// photo is only scaled to fit the canvas, and branding is composited on top in empty space, found in code from the
// product boxes SAM 3.1 returns. If there is no room, the logo shrinks into the least-busy corner and the owner is told.
export const FORMATS = { square: { w: 1080, h: 1080 }, portrait: { w: 1080, h: 1350 } };
const LOGO_SCALES = [0.15, 0.14, 0.13, 0.12]; // of the image width: roughly 12 to 18%, 15% when there is room
const SMALL_LOGO = 0.08; // the fallback when nothing fits
const MARGIN = 0.03; // safe distance from the image edge, of the width
const PAD = 0.025; // clear space kept around every product box, of the width
const SAM_MIN_CONFIDENCE = 0.3;
const MAX_BOXES = 12;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---- finding the product (SAM 3.1) --------------------------------------------------------------------
const outputText = (res) => res.output_text ?? (res.output ?? []).flatMap((o) => (o.content ?? []).map((c) => c.text ?? '')).join('');
const boxesIn = (text) => [...String(text).matchAll(/<\|box;([^|]*)\|>/g)]
  .map((m) => Object.fromEntries(m[1].split(';').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)])));

// One phrase per request (SAM takes a single concept). Boxes come back in pixels of the image sent, x2 and y2
// inclusive, so they are turned into 0..1 fractions of the photo here.
export async function samBoxes(jpeg, phrase) {
  const res = await fetch('https://api.meta.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELS.sam,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }, { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }] }],
      metadata: { include_confidence: 'true', mask_encoding: 'one_bit' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message ?? `SAM returned HTTP ${res.status}`), { status: res.status, error: body.error });
  return boxesIn(outputText(body))
    .filter((b) => b.w > 0 && b.h > 0 && (b.c == null || b.c >= SAM_MIN_CONFIDENCE))
    .map((b) => ({ x1: b.x1 / b.w, y1: b.y1 / b.h, x2: Math.min(1, (b.x2 + 1) / b.w), y2: Math.min(1, (b.y2 + 1) / b.h), c: b.c ?? null }))
    .sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1))
    .slice(0, MAX_BOXES);
}

// Step 1: Muse Spark names the product in a few words (SAM works best with a short noun phrase) and says whether it is
// worn or held by a person. A phrase from the photo analysis, if the post creation already made one, is only a hint.
export async function productPhrase(photo, hint) {
  const small = await sharp(photo).rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const { data } = await completeJSON('branding_phrase', {
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Name the main product for sale in this photo as a short noun phrase of 2 to 4 words that an object detector can find, for example "white sneakers" or "red handbag". Say whether a person is wearing or holding it.${hint ? ` A description from the seller's catalog, for reference: ${JSON.stringify(String(hint).slice(0, 120))}.` : ''} Return JSON {"phrase": "...", "worn": true or false}.` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${small.toString('base64')}` } },
    ] }],
    response_format: { type: 'json_schema', json_schema: { name: 'branding_phrase', schema: { type: 'object', properties: { phrase: { type: 'string' }, worn: { type: 'boolean' } }, required: ['phrase', 'worn'], additionalProperties: false } } },
  }, { validate: (d) => { if (typeof d?.phrase !== 'string') throw new Error('answer has no phrase'); } });
  return { phrase: data.phrase.replace(/[^\p{L}\p{N} '-]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ') || null, worn: !!data.worn };
}

const cache = new Map(); // photo + phrase -> detection, so toggling formats and positions never calls SAM again
const remember = (key, value) => { if (cache.size >= 200) cache.delete(cache.keys().next().value); cache.set(key, value); return value; };

// The product phrase comes from Muse Spark (the photo analysis or the photo tags). SAM is asked for it first, then for
// "person", then for "product". A worn product also blocks the person, so a logo never lands on the model's body.
export async function detectProduct(photo, { phrase, worn = false } = {}) {
  const key = `${createHash('sha1').update(photo).digest('hex')}|${phrase ?? ''}|${worn}`;
  if (cache.has(key)) return cache.get(key);
  const small = await sharp(photo).rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const tried = [];
  let boxes = [];
  let used = null;
  for (const p of [...new Set([phrase, 'person', 'product'].filter(Boolean))]) {
    const found = await samBoxes(small, p);
    tried.push({ phrase: p, boxes: found.length });
    if (found.length) { boxes = found; used = p; break; }
  }
  if (worn && used && used !== 'person') {
    const people = await samBoxes(small, 'person');
    tried.push({ phrase: 'person', boxes: people.length });
    boxes = [...boxes, ...people].slice(0, MAX_BOXES);
  }
  return remember(key, { boxes, phrase_used: used, tried });
}

// ---- finding empty space ---------------------------------------------------------------------------------
const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const area = (r) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);

// The biggest empty rectangle touching one corner of the safe area: try every width a product box allows.
function cornerRegion(corner, safe, blocked) {
  const flipX = corner.includes('r');
  const flipY = corner.includes('b');
  const mx = (r) => (flipX ? { x0: safe.x0 + safe.x1 - r.x1, x1: safe.x0 + safe.x1 - r.x0 } : { x0: r.x0, x1: r.x1 });
  const my = (r) => (flipY ? { y0: safe.y0 + safe.y1 - r.y1, y1: safe.y0 + safe.y1 - r.y0 } : { y0: r.y0, y1: r.y1 });
  const bl = blocked.map((r) => ({ ...mx(r), ...my(r) }));
  const widths = [safe.x1 - safe.x0, ...bl.filter((b) => b.x0 > safe.x0).map((b) => b.x0 - safe.x0)].filter((w) => w > 0);
  let best = { x0: safe.x0, y0: safe.y0, x1: safe.x0, y1: safe.y0 };
  for (const w of widths) {
    const xr = safe.x0 + Math.min(w, safe.x1 - safe.x0);
    const h = Math.min(safe.y1 - safe.y0, ...bl.filter((b) => b.x0 < xr && b.x1 > safe.x0).map((b) => Math.max(0, b.y0 - safe.y0)));
    if (h > 0 && (xr - safe.x0) * h > area(best)) best = { x0: safe.x0, y0: safe.y0, x1: xr, y1: safe.y0 + h };
  }
  // back to real coordinates
  const ux = flipX ? { x0: safe.x0 + safe.x1 - best.x1, x1: safe.x0 + safe.x1 - best.x0 } : { x0: best.x0, x1: best.x1 };
  const uy = flipY ? { y0: safe.y0 + safe.y1 - best.y1, y1: safe.y0 + safe.y1 - best.y0 } : { y0: best.y0, y1: best.y1 };
  return { ...ux, ...uy };
}

// Candidates: the four corners and the top and bottom bands, each as empty as the product boxes allow.
export function candidateRegions(safe, blocked) {
  const top = Math.min(safe.y1, ...blocked.map((r) => Math.max(safe.y0, r.y0)));
  const bottom = Math.max(safe.y0, ...blocked.map((r) => Math.min(safe.y1, r.y1)));
  return [
    ...['tl', 'tr', 'bl', 'br'].map((id) => ({ id, kind: 'corner', rect: cornerRegion(id, safe, blocked) })),
    { id: 'top', kind: 'band', rect: { x0: safe.x0, y0: safe.y0, x1: safe.x1, y1: blocked.length ? top : safe.y1 } },
    { id: 'bottom', kind: 'band', rect: { x0: safe.x0, y0: blocked.length ? bottom : safe.y0, x1: safe.x1, y1: safe.y1 } },
  ].filter((r) => area(r.rect) > 0);
}

// Where a w x h item goes inside a region: against its corner, or centred in a band, kept away from the product.
function placeIn(region, w, h) {
  const r = region.rect;
  const at = {
    tl: [r.x0, r.y0], tr: [r.x1 - w, r.y0], bl: [r.x0, r.y1 - h], br: [r.x1 - w, r.y1 - h],
    top: [(r.x0 + r.x1 - w) / 2, r.y0], bottom: [(r.x0 + r.x1 - w) / 2, r.y1 - h],
  }[region.id];
  return { x0: Math.round(at[0]), y0: Math.round(at[1]), x1: Math.round(at[0] + w), y1: Math.round(at[1] + h) };
}
const fits = (region, w, h) => region.rect.x1 - region.rect.x0 >= w && region.rect.y1 - region.rect.y0 >= h;

// ---- looking at the pixels ---------------------------------------------------------------------------------
async function luminanceMap(canvasBuffer, W, H) {
  const scale = 240 / W;
  const w = Math.round(W * scale);
  const h = Math.round(H * scale);
  const raw = await sharp(canvasBuffer).resize(w, h).greyscale().raw().toBuffer();
  return {
    scale,
    stats(r) { // mean brightness (0..1) and how busy the area is (spread of brightness)
      const x0 = Math.max(0, Math.floor(r.x0 * scale)); const x1 = Math.min(w, Math.ceil(r.x1 * scale));
      const y0 = Math.max(0, Math.floor(r.y0 * scale)); const y1 = Math.min(h, Math.ceil(r.y1 * scale));
      let sum = 0; let sq = 0; let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = raw[y * w + x] / 255; sum += v; sq += v * v; n++; }
      if (!n) return { mean: 0.5, busy: 0 };
      const mean = sum / n;
      return { mean, busy: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
    },
  };
}

// ---- the logo, in the version that shows on this background ---------------------------------------------------
async function recolor(png, rgb) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; }
  return sharp(data, { raw: info }).png().toBuffer();
}
async function logoLuminance(png) {
  const { data } = await sharp(png).ensureAlpha().resize(64, 64, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  let sum = 0; let weight = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3] / 255; sum += a * (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255; weight += a; }
  return weight ? sum / weight : 0.5;
}

// The logo as it is when it stands out on this background, otherwise a light or a dark version of it.
export async function logoFor(png, backgroundLuminance) {
  const own = await logoLuminance(png);
  if (Math.abs(own - backgroundLuminance) >= 0.3) return { png, variant: 'original' }; // the brand color, wherever it is readable
  return backgroundLuminance > 0.55
    ? { png: await recolor(png, [27, 27, 27]), variant: 'dark' }
    : { png: await recolor(png, [255, 255, 255]), variant: 'light' };
}

// ---- the price badge: text drawn as shapes from a bundled font, so it looks the same on every server -------------------
let font;
const loadFont = () => {
  if (!font) { const b = fs.readFileSync(new URL('../assets/fonts/inter-latin-700.woff', import.meta.url)); font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  return font;
};
function textShape(text, size) {
  const f = loadFont();
  let x = 0; let d = '';
  for (const ch of String(text)) { const g = f.charToGlyph(ch); d += g.getPath(x, 0, size).toPathData(2); x += (g.advanceWidth * size) / f.unitsPerEm; }
  return { d, width: x };
}
const hexToRgb = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [18, 105, 74]; };
const luma = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export function badgeShape({ price, offer }, W, color, scale = 1) {
  const lines = [];
  if (price != null && price !== '') lines.push({ text: `Tk ${Number(price).toLocaleString('en-US')}`, size: W * 0.05 * scale });
  if (offer) lines.push({ text: String(offer).slice(0, 22), size: W * 0.032 * scale });
  if (!lines.length) return null;
  const shaped = lines.map((l) => ({ ...l, ...textShape(l.text, l.size) }));
  const pad = W * 0.022 * scale;
  const gap = W * 0.008 * scale;
  const width = Math.ceil(Math.max(...shaped.map((l) => l.width)) + pad * 2);
  const height = Math.ceil(shaped.reduce((n, l) => n + l.size * 0.78, 0) + gap * (shaped.length - 1) + pad * 2);
  let y = pad;
  const ink = luma(hexToRgb(color)) > 0.6 ? '#1b1b1b' : '#ffffff';
  const paths = shaped.map((l) => { y += l.size * 0.78; const out = `<path transform="translate(${(width - l.width) / 2} ${y})" d="${l.d}" fill="${ink}"/>`; y += gap; return out; }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${Math.round(height * 0.3)}" fill="${color}"/>${paths}</svg>`;
  return { svg: Buffer.from(svg), width, height };
}

// ---- putting it together -----------------------------------------------------------------------------------
// photo: the product photo. boxes: SAM's product boxes as fractions of the photo. logo: a transparent PNG or null.
// options: { logo, badge, format, region, padding }. Returns the JPEG and how it was made.
export async function renderBranded({ photo, boxes = [], logo = null, price = null, offer = null, color = '#12694A', options = {} }) {
  const { logo: wantLogo = true, badge: wantBadge = true, format = 'square', region = 0, padding = 'blur' } = options;
  const { w: W, h: H } = FORMATS[format] ?? FORMATS.square;
  const notes = [];

  const upright = await sharp(photo).rotate().toBuffer(); // camera rotation applied first, so the size below is the size you see
  const { width: pw, height: ph } = await sharp(upright).metadata();
  const scale = Math.min(W / pw, H / ph);
  const fw = Math.round(pw * scale); const fh = Math.round(ph * scale);
  const ox = Math.round((W - fw) / 2); const oy = Math.round((H - fh) / 2);
  const placed = await sharp(upright).resize(fw, fh, { kernel: 'lanczos3' }).toBuffer();

  // padding is blurred photo or brand color, never a crop into the product
  const background = padding === 'brand' || (fw === W && fh === H)
    ? sharp({ create: { width: W, height: H, channels: 3, background: color } }).jpeg().toBuffer()
    : sharp(upright).resize(W, H, { fit: 'cover' }).blur(32).modulate({ brightness: 0.92 }).jpeg().toBuffer();
  const base = await sharp(await background).composite([{ input: placed, left: ox, top: oy }]).jpeg({ quality: 92 }).toBuffer();

  let blocked = boxes.map((b) => ({ x0: ox + b.x1 * fw, y0: oy + b.y1 * fh, x1: ox + b.x2 * fw, y1: oy + b.y2 * fh }));
  if (!blocked.length) { // nothing was found: treat the middle of the photo as the product, so branding stays out of it
    blocked = [{ x0: ox + fw * 0.12, y0: oy + fh * 0.12, x1: ox + fw * 0.88, y1: oy + fh * 0.88 }];
    notes.push('The product could not be found in this photo, so the logo stays at the edges.');
  }
  const pad = W * PAD;
  blocked = blocked.map((r) => ({ x0: Math.max(0, r.x0 - pad), y0: Math.max(0, r.y0 - pad), x1: Math.min(W, r.x1 + pad), y1: Math.min(H, r.y1 + pad) }));
  const margin = W * MARGIN;
  const safe = { x0: margin, y0: margin, x1: W - margin, y1: H - margin };
  const lum = await luminanceMap(base, W, H);

  const result = { width: W, height: H, photo: { x: ox, y: oy, w: fw, h: fh }, blocked, regions: [], logo: null, badge: null, notes, small_logo: false };
  const overlays = [];
  let occupied = [...blocked];

  // ---- logo
  let logoRect = null;
  if (wantLogo && logo) {
    const meta = await sharp(logo).metadata();
    const aspect = meta.width / meta.height;
    const sizeAt = (s) => { const w = Math.round(W * s); return { w, h: Math.min(Math.round(w / aspect), Math.round(H * 0.25)) }; };
    const regions = candidateRegions(safe, occupied);
    const valid = regions.filter((r) => LOGO_SCALES.some((s) => fits(r, sizeAt(s).w, sizeAt(s).h)))
      .map((r) => ({ ...r, area: area(r.rect), busy: lum.stats(r.rect).busy }))
      .sort((a, b) => (Math.abs(b.area - a.area) < 0.1 * Math.max(a.area, b.area) ? a.busy - b.busy : b.area - a.area));
    result.regions = valid.map((r) => ({ id: r.id, kind: r.kind, rect: r.rect }));
    if (valid.length) {
      const chosen = valid[((region % valid.length) + valid.length) % valid.length];
      const s = LOGO_SCALES.find((x) => fits(chosen, sizeAt(x).w, sizeAt(x).h));
      const { w, h } = sizeAt(s);
      logoRect = placeIn(chosen, w, h);
      result.logo = { region: chosen.id, scale: s, ...logoRect };
    } else {
      // no room: a small logo in the least-busy corner, kept off the product where any corner allows it
      const { w, h } = sizeAt(SMALL_LOGO);
      const corners = ['tl', 'tr', 'bl', 'br'].map((id) => {
        const rect = placeIn({ id, rect: safe }, w, h);
        return { id, rect, overlap: occupied.reduce((n, b) => n + overlap(rect, b), 0), busy: lum.stats(rect).busy };
      }).sort((a, b) => a.overlap - b.overlap || a.busy - b.busy);
      logoRect = corners[0].rect;
      result.logo = { region: corners[0].id, scale: SMALL_LOGO, ...logoRect };
      result.small_logo = true;
      result.regions = [{ id: corners[0].id, kind: 'corner', rect: logoRect }];
      notes.push(corners[0].overlap > 0
        ? 'This photo is full of product, so the logo is small and sits in the quietest corner. It may touch the product: try the portrait format, which adds space around the photo.'
        : 'This photo is crowded, so the logo is small and sits in the quietest corner.');
    }
    const bg = lum.stats(logoRect).mean;
    const resized = await sharp(logo).resize(logoRect.x1 - logoRect.x0, logoRect.y1 - logoRect.y0, { fit: 'inside' }).toBuffer();
    const version = await logoFor(resized, bg);
    result.logo.variant = version.variant;
    result.logo.background_brightness = Math.round(bg * 100) / 100;
    overlays.push({ input: version.png, left: logoRect.x0, top: logoRect.y0 });
    occupied = [...occupied, { x0: logoRect.x0 - pad, y0: logoRect.y0 - pad, x1: logoRect.x1 + pad, y1: logoRect.y1 + pad }];
  } else if (wantLogo && !logo) notes.push('Add your logo in Brand settings to put it on the photo.');

  // ---- price badge, in the next-best empty region
  if (wantBadge) {
    if (!badgeShape({ price, offer }, W, color)) notes.push('The price badge needs a price.');
    else {
      // full size first, then smaller, so a badge is only dropped when even a small one has no room
      const free = candidateRegions(safe, occupied);
      let done = false;
      for (const scale of [1, 0.8, 0.65]) {
        const shape = badgeShape({ price, offer }, W, color, scale);
        const regions = free.filter((r) => fits(r, shape.width, shape.height)).sort((a, b) => area(b.rect) - area(a.rect));
        if (!regions.length) continue;
        const rect = placeIn(regions[0], shape.width, shape.height);
        result.badge = { region: regions[0].id, scale, ...rect };
        overlays.push({ input: await sharp(shape.svg).png().toBuffer(), left: rect.x0, top: rect.y0 });
        done = true;
        break;
      }
      if (!done) notes.push('There is no empty space left for the price badge on this photo.');
    }
  }

  const buffer = await sharp(base).composite(overlays).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
  return { buffer, ...result };
}

// ---- self-check used by tests: nothing branded may overlap a product box ----------------------------------------------
export function overlapsProduct(result) {
  const boxes = result.blocked.map((b) => ({ ...b })); // already inflated: strictly more demanding than the product itself
  return [result.logo, result.badge].filter(Boolean).filter((item) => !result.small_logo || item !== result.logo)
    .some((item) => boxes.some((b) => overlap({ x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1 }, b) > 0));
}
