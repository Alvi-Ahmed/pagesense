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

// Demo visitors cannot rerun analysis (the demo is read-only), so restore its result from the snapshot.
if (snap.playbook) {
  const { count } = await db.from('playbooks').select('*', { count: 'exact', head: true }).eq('page_id', 'demo');
  if (!count) {
    const { error } = await db.from('playbooks').insert({ page_id: 'demo', ...snap.playbook });
    if (error) throw new Error(`playbooks: ${error.message}`);
    console.log('playbooks 1');
  }
}
const { count: jobs } = await db.from('analysis_jobs').select('*', { count: 'exact', head: true }).eq('page_id', 'demo');
if (!jobs) {
  const now = new Date().toISOString();
  const { error } = await db.from('analysis_jobs').insert({
    page_id: 'demo', status: 'done', processed: 1, total: 1, started_at: now, finished_at: now,
  });
  if (error) throw new Error(`analysis_jobs: ${error.message}`);
  console.log('analysis_jobs 1');
}
