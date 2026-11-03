import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';

export const BUCKET = 'product-photos';
export const MAX_BYTES = 10 * 1024 * 1024; // per photo, as uploaded
const FULL_PX = 2048; // stored copy
const ANALYSIS_PX = 768; // what the model sees
const SIGNED_SECONDS = 3600;
const REF = `storage://${BUCKET}/`;

const bad = (message) => Object.assign(new Error(message), { status: 400 });

let bucketReady = null;
// The bucket is private: photos are only shown through short-lived signed links.
export function ensureBucket() {
  bucketReady ??= (async () => {
    const { data, error } = await db.storage.listBuckets();
    if (error) throw error;
    if (data.some((b) => b.name === BUCKET)) return;
    const { error: err } = await db.storage.createBucket(BUCKET, { public: false, fileSizeLimit: MAX_BYTES, allowedMimeTypes: ['image/jpeg'] });
    if (err && !/already exists/i.test(err.message)) throw err;
  })().catch((e) => { bucketReady = null; throw e; });
  return bucketReady;
}

// Decode, apply the camera's rotation, then re-encode as JPEG. sharp writes no metadata unless asked, so EXIF,
// GPS location and camera details do not survive. Returns the stored copy, the smaller copy for analysis and the size.
export async function cleanPhoto(buffer) {
  if (!buffer?.length) throw bad('That photo is empty.');
  if (buffer.length > MAX_BYTES) throw bad('Each photo must be 10 MB or smaller.');
  try {
    const full = await sharp(buffer, { limitInputPixels: 100e6 }).rotate()
      .resize({ width: FULL_PX, height: FULL_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const analysis = await sharp(full).resize({ width: ANALYSIS_PX, height: ANALYSIS_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 }).toBuffer();
    const { width, height } = await sharp(full).metadata();
    return { full, analysis, width, height };
  } catch {
    throw bad('We could not read that file as a photo. Use a JPEG, PNG or WebP image.');
  }
}

export const toDataUrl = (jpeg) => `data:image/jpeg;base64,${jpeg.toString('base64')}`;

// ---- Supabase Storage ---------------------------------------------------------------------
export const isStored = (url) => typeof url === 'string' && url.startsWith(REF);
export const refFor = (path) => `${REF}${path}`;
const pathOf = (ref) => ref.slice(REF.length);

export async function storePhoto(pageId, buffer) {
  await ensureBucket();
  const id = randomUUID();
  const path = `${pageId}/${id}.jpg`;
  const { error } = await db.storage.from(BUCKET).upload(path, buffer, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return { id, path };
}

// Facebook's picture links are signed and expire within a day, so every post photo is copied into our own bucket at
// sync time and posts.photo_url holds the storage ref. A photo that cannot be copied keeps its Facebook link.
const POST_PX = 1080;
const ARCHIVE_CONCURRENCY = 6;

// The bytes behind a stored ref or a plain URL.
export async function photoBytes(url) {
  if (isStored(url)) {
    const { data, error } = await db.storage.from(BUCKET).download(pathOf(url));
    if (error || !data) throw new Error(`stored photo not found: ${error?.message ?? 'empty'}`);
    return Buffer.from(await data.arrayBuffer());
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`photo download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Copy one post photo into the bucket; returns its storage ref, or null when it could not be fetched.
export async function archivePostPhoto(pageId, postId, url) {
  try {
    await ensureBucket();
    const jpeg = await sharp(await photoBytes(url), { limitInputPixels: 100e6 }).rotate()
      .resize({ width: POST_PX, height: POST_PX, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    const path = `${pageId}/posts/${postId}.jpg`;
    const { error } = await db.storage.from(BUCKET).upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
    if (error) throw error;
    return refFor(path);
  } catch (e) {
    console.error('could not store post photo', postId, e.message);
    return null;
  }
}

// Post rows about to be saved: photos already stored stay as they are, the rest are copied in.
export async function archiveRows(pageId, rows) {
  const ids = rows.filter((r) => r.photo_url).map((r) => r.id);
  if (!ids.length) return rows;
  const { data } = await db.from('posts').select('id, photo_url').in('id', ids);
  const kept = new Map((data ?? []).filter((r) => isStored(r.photo_url)).map((r) => [r.id, r.photo_url]));
  const todo = rows.filter((r) => r.photo_url && !kept.has(r.id));
  for (const r of rows) if (kept.has(r.id)) r.photo_url = kept.get(r.id);
  await Promise.all(Array.from({ length: ARCHIVE_CONCURRENCY }, async () => {
    for (let r; (r = todo.shift());) r.photo_url = (await archivePostPhoto(pageId, r.id, r.photo_url)) ?? r.photo_url;
  }));
  return rows;
}

// A stored ref (storage://...) or plain URL into a link the browser can show.
export async function showableUrl(url) {
  if (!isStored(url)) return url;
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(pathOf(url), SIGNED_SECONDS);
  return error ? null : data.signedUrl;
}

// A photo this page uploaded, by upload id. Ids are checked so one page can never read another page's files.
export async function loadStored(pageId, uploadId) {
  if (!/^[0-9a-f-]{36}$/.test(String(uploadId))) throw bad('Unknown photo.');
  const { data, error } = await db.storage.from(BUCKET).download(`${pageId}/${uploadId}.jpg`);
  if (error || !data) throw bad('Photo not found. Upload it again.');
  return Buffer.from(await data.arrayBuffer());
}
