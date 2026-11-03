// Copy the demo posts' photos into our own storage and point the snapshot and the demo rows at the copies, because
// Facebook picture links expire within a day. The demo's posts have anonymised ids, so each one is matched to the real
// post it was exported from by its creation time, and a fresh picture link is read from Facebook with that page's token.
// Run: npm run demo:photos [-- <pageId>]   (default: the synced page with the most posts)
import fs from 'node:fs';
import { db } from '../src/db.js';
import { graph } from '../src/facebook.js';
import { archivePostPhoto, isStored } from '../src/photos.js';

const file = new URL('../demo/snapshot.json', import.meta.url);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));

let pageId = process.argv[2];
if (!pageId) {
  const { data } = await db.from('pages').select('id').neq('id', 'demo').not('access_token', 'is', null);
  let best = -1;
  for (const p of data ?? []) {
    const { count } = await db.from('posts').select('*', { count: 'exact', head: true }).eq('page_id', p.id);
    if (count > best) { best = count; pageId = p.id; }
  }
}
if (!pageId || pageId === 'demo') throw new Error('No synced page with a Facebook token found');
const { data: page } = await db.from('pages').select('id, name, access_token').eq('id', pageId).single();

const real = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('posts').select('id, created_time').eq('page_id', pageId).range(from, from + 999);
  if (error) throw error;
  real.push(...data);
  if (data.length < 1000) break;
}
const idByTime = new Map(real.map((r) => [new Date(r.created_time).getTime(), r.id]));

const todo = snap.posts.filter((p) => p.photo_url && !isStored(p.photo_url));
console.log(`page "${page.name}": ${todo.length} demo photos to copy`);
let done = 0, missing = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let p; (p = todo.shift());) {
    const realId = idByTime.get(new Date(p.created_time).getTime());
    let ref = null;
    if (realId) {
      try {
        const { full_picture } = await graph(`/${realId}`, { access_token: page.access_token, fields: 'full_picture' });
        if (full_picture) ref = await archivePostPhoto('demo', p.id, full_picture);
      } catch (e) { console.error('no picture for', p.id, e.message); }
    }
    if (!ref) { missing++; continue; }
    p.photo_url = ref;
    const { error } = await db.from('posts').update({ photo_url: ref }).eq('id', p.id).eq('page_id', 'demo');
    if (error) throw error;
    done++;
  }
}));
fs.writeFileSync(file, JSON.stringify(snap, null, 1));
console.log(`copied ${done}, could not copy ${missing}`);
