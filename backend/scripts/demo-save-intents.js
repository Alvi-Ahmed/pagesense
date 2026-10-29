// Copy intent/size/color for the demo comments from the database into demo/snapshot.json, so a fresh
// `npm run demo:seed` already has them. Run after the analysis job has classified the demo page.
// Run: npm run demo:save-intents
import fs from 'node:fs';
import { db } from '../src/db.js';

const file = new URL('../demo/snapshot.json', import.meta.url);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));

const byId = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('comments').select('id, intent, size, color')
    .like('id', 'demo_c%').order('id').range(from, from + 999);
  if (error) throw error;
  data.forEach((c) => byId.set(c.id, c));
  if (data.length < 1000) break;
}

let filled = 0;
for (const c of snap.comments) {
  const row = byId.get(c.id);
  if (!row) continue;
  c.intent = row.intent; c.size = row.size; c.color = row.color;
  if (row.intent) filled++;
}
fs.writeFileSync(file, JSON.stringify(snap, null, 1));
console.log(`snapshot comments with intent: ${filled} of ${snap.comments.length}`);
