import { db } from './db.js';

// comments.is_page / answered come from migration 003. Until it is applied, code that filters on them
// falls back to the old behaviour instead of failing.
let cached = { at: 0, value: false };
export async function hasAuthorColumns() {
  if (cached.value || Date.now() - cached.at < 60_000) return cached.value;
  const { error } = await db.from('comments').select('is_page, answered').limit(1);
  cached = { at: Date.now(), value: !error };
  return cached.value;
}

// analysis_stages comes from migration 004. Cached like the check above.
let stageTable = { at: 0, value: false };
export async function hasStageTable() {
  if (stageTable.value || Date.now() - stageTable.at < 60_000) return stageTable.value;
  const { error } = await db.from('analysis_stages').select('stage').limit(1);
  stageTable = { at: Date.now(), value: !error };
  return stageTable.value;
}
