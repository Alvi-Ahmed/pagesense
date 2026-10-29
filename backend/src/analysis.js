import { db } from './db.js';
import { hasUntaggedSince, tagPage } from './tag.js';
import { classifyPage, hasUnclassifiedSince } from './classify.js';
import { buildPlaybook, latestPlaybook } from './playbook.js';
import { hasStageTable } from './schema.js';
import { DEMO_PAGE_ID } from './demo.js';

// Pipeline stages, in order. `version` goes up when a stage's logic changes enough that old results should be
// redone (a new prompt, a new model): every page recorded at an older version then reruns that stage on ALL its
// items. `hasNewWork(pageId, since)` says whether items arrived after the stage last completed.
// Later items add catalog, orders.
export const STAGES = [
  {
    name: 'tagging', version: 1,
    run: (pageId, p) => tagPage(pageId, p),
    hasNewWork: hasUntaggedSince,
  },
  {
    name: 'classification', version: 1,
    run: (pageId, p) => classifyPage(pageId, p),
    hasNewWork: hasUnclassifiedSince,
  },
  {
    name: 'playbook', version: 1,
    run: (pageId, p) => buildPlaybook(pageId, p),
    // the playbook is rebuilt whenever an earlier stage did work (see plan()); on its own it only needs to exist
    hasNewWork: async (pageId) => (await latestPlaybook(pageId)).status === 'none',
  },
];

// What to log/store from a failed API call: the response body, not just "400 Bad Request".
function errorDetail(err) {
  return { status: err.status ?? null, body: err.error ?? err.response?.data ?? null, message: err.message };
}

const update = async (id, fields) => {
  const { error } = await db.from('analysis_jobs').update(fields).eq('id', id);
  if (error) console.error('analysis_jobs update failed:', error.message);
};

// ---- stage records ------------------------------------------------------------------------
// null when migration 004 has not been applied: callers then fall back to "run whatever is missing".
async function stageRecords(pageId) {
  if (!(await hasStageTable())) return null;
  const { data, error } = await db.from('analysis_stages').select('stage, version, completed_at').eq('page_id', pageId);
  if (error) throw error;
  return new Map(data.map((r) => [r.stage, r]));
}

async function recordStage(pageId, stage) {
  if (!(await hasStageTable())) return;
  const { error } = await db.from('analysis_stages').upsert({
    page_id: pageId, stage: stage.name, version: stage.version, completed_at: new Date().toISOString(),
  });
  if (error) console.error('could not record stage', stage.name, error.message);
}

// ---- planning -----------------------------------------------------------------------------
// Which stages need to run for this page, and on which items.
//   no record            -> run, on the items that are missing
//   record older version -> run, on every item again
//   force                -> run, on every item again
//   newer items since    -> run, on the new items only (stages skip what they have already done)
//   earlier stage ran    -> the playbook is rebuilt
export async function plan(pageId, { force = false } = {}) {
  const records = await stageRecords(pageId);
  const planned = [];
  for (const stage of STAGES) {
    // without the table there is no history: treat every stage as current and look for missing items only
    const rec = records ? records.get(stage.name) : { version: stage.version, completed_at: null };
    let reason = null;
    let all = false;
    if (force) { reason = 're-analyse'; all = true; }
    else if (!rec) reason = 'never run';
    else if (rec.version < stage.version) { reason = `version ${rec.version} -> ${stage.version}`; all = true; }
    else if (await stage.hasNewWork(pageId, rec.completed_at)) reason = 'new items';
    else if (stage.name === 'playbook' && planned.length) reason = 'earlier stages changed the data';
    if (reason) planned.push({ stage, all, reason });
  }
  return planned;
}

// ---- running ------------------------------------------------------------------------------
async function runJob(job, planned) {
  await update(job.id, { status: 'running', started_at: new Date().toISOString() });
  let failed = 0;
  try {
    // processed/total run across all stages: each stage's counts are added to what earlier stages did.
    let base = 0;
    for (const { stage, all, reason } of planned) {
      console.log(`analysis ${job.page_id}: ${stage.name} (${reason}${all ? ', all items' : ''})`);
      await update(job.id, { stage: stage.name, ...(base === 0 && { processed: 0, total: 0 }) });
      let stageTotal = 0;
      const result = await stage.run(job.page_id, {
        all,
        // called by a stage as it makes progress
        progress: (processed, total) => {
          stageTotal = total;
          return update(job.id, { processed: base + processed, total: base + total });
        },
      });
      base += stageTotal;
      failed += result?.failed ?? 0;
      if ((result?.tagged ?? result?.classified) === 0 && result?.failed > 0) {
        throw new Error(`${stage.name}: all ${result.failed} items failed. Check the server log for the cause.`);
      }
      await recordStage(job.page_id, stage);
    }
    await update(job.id, { status: 'done', stage: null, failed_count: failed, finished_at: new Date().toISOString() });
  } catch (err) {
    const detail = errorDetail(err);
    console.error(`analysis failed (page ${job.page_id}, stage ${job.stage}):`, JSON.stringify(detail));
    await update(job.id, {
      status: 'failed', error: err.message, error_detail: detail, failed_count: failed,
      finished_at: new Date().toISOString(),
    });
  }
}

export async function latestAnalysis(pageId) {
  const { data, error } = await db.from('analysis_jobs').select('*')
    .eq('page_id', pageId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data || { status: 'idle' };
}

// Opening a page, a restart and a sync all ask for the same thing; don't repeat it within a couple of minutes.
const lastCheck = new Map();
const CHECK_EVERY_MS = 2 * 60_000;

// source: 'open' (page opened or backend started) or 'sync'. Runs whichever stages are missing, out of date, or have new items, in a background job, and returns that job.
// If nothing needs doing it creates no job and returns the latest one. `force` (the Re-analyse button) reruns
// every stage on every item. If a run is already queued or running, that one is returned.
export async function startAnalysis(pageId, { force = false, source = 'open' } = {}) {
  if (pageId === DEMO_PAGE_ID) return latestAnalysis(pageId); // the demo is read-only
  const current = await latestAnalysis(pageId);
  if (current.status === 'queued' || current.status === 'running') return current;

  if (!force && source !== 'sync') { // a finished sync always checks for the items it brought in
    if (Date.now() - (lastCheck.get(pageId) ?? 0) < CHECK_EVERY_MS && current.status === 'done') return current;
    lastCheck.set(pageId, Date.now());
  }
  const planned = await plan(pageId, { force });
  if (!planned.length) {
    if (current.status !== 'failed') return current;
    // Nothing is left to do, so an old failed job (interrupted, stopped by the owner) must not stay as a red banner.
    const now = new Date().toISOString();
    const { data: ok, error: err } = await db.from('analysis_jobs')
      .insert({ page_id: pageId, status: 'done', started_at: now, finished_at: now }).select().single();
    if (err) throw err;
    return ok;
  }

  const { data: job, error } = await db.from('analysis_jobs')
    .insert({ page_id: pageId }).select().single();
  if (error) throw error;
  runJob(job, planned); // background: not awaited
  return job;
}

// Render restarts kill in-flight runs; mark them failed so the app shows Retry instead of spinning forever.
export async function failInterruptedJobs() {
  const { error } = await db.from('analysis_jobs').update({
    status: 'failed', error: 'Interrupted by a server restart', finished_at: new Date().toISOString(),
  }).in('status', ['queued', 'running']);
  if (error) console.error('could not clean up interrupted jobs:', error.message);
}

// On startup: bring every connected page up to date (missing stages, older versions, items added since).
export async function resumeAnalyses() {
  const { data, error } = await db.from('pages').select('id').neq('id', DEMO_PAGE_ID).not('access_token', 'is', null);
  if (error) return console.error('could not list pages:', error.message);
  for (const { id } of data) {
    try { await startAnalysis(id); } catch (e) { console.error(`could not resume analysis for ${id}:`, e.message); }
  }
}
