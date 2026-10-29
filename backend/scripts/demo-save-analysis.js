// Rebuild the demo playbook, then copy the AI results for the demo page (post tags, comment intents/size/color
// and the playbook) from the database into demo/snapshot.json, so a fresh `npm run demo:seed` has them all.
// This is a maintainer script: the demo page itself is read-only for visitors.
// Run: npm run demo:save-analysis
import fs from 'node:fs';
import { db } from '../src/db.js';
import { buildPlaybook, latestPlaybook } from '../src/playbook.js';

const file = new URL('../demo/snapshot.json', import.meta.url);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));

const fetchAll = async (build) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
};

const comments = new Map((await fetchAll(() => db.from('comments').select('id, intent, size, color')
  .like('id', 'demo_c%').order('id'))).map((c) => [c.id, c]));
let classified = 0;
for (const c of snap.comments) {
  const row = comments.get(c.id);
  if (!row) continue;
  c.intent = row.intent; c.size = row.size; c.color = row.color;
  if (row.intent) classified++;
}

snap.post_tags = (await fetchAll(() => db.from('post_tags').select('*').like('post_id', 'demo_p%').order('post_id')))
  .map(({ created_at, ...tag }) => tag); // eslint-disable-line no-unused-vars

await buildPlaybook('demo');
const { data, summary } = await latestPlaybook('demo');
snap.playbook = { data, summary };

fs.writeFileSync(file, JSON.stringify(snap, null, 1));
console.log(`snapshot: ${classified}/${snap.comments.length} comments with intent, ${snap.post_tags.length} post tags, playbook saved`);
