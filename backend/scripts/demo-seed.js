// Load demo/snapshot.json into the database as page "demo". Idempotent; touches only demo rows.
// Run: npm run demo:seed
import fs from 'node:fs';
import { db } from '../src/db.js';

const snap = JSON.parse(fs.readFileSync(new URL('../demo/snapshot.json', import.meta.url), 'utf8'));

async function upsert(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  console.log(table, rows.length);
}

// No access_token: the demo page can never talk to Facebook.
await upsert('pages', [{ ...snap.page, access_token: null }]);
await upsert('posts', snap.posts.map((p) => ({ ...p, page_id: 'demo' })));
await upsert('comments', snap.comments);
await upsert('post_tags', snap.post_tags);
