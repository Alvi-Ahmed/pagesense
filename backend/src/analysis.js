import { db } from './db.js';
import { tagPage } from './tag.js';

// Pipeline stages run in order after a sync. Later items add classify, playbook, catalog, orders.
const STAGES = [
  { name: 'tagging', run: (pageId, p) => tagPage(pageId, p) },
];

// What to log/store from a failed API call: the response body, not just "400 Bad Request".
function errorDetail(err) {
  return { status: err.status ?? null, body: err.error ?? err.response?.data ?? null, message: err.message };
}

const update = async (id, fields) => {
  const { error } = await db.from('analysis_jobs').update(fields).eq('id', id);
  if (error) console.error('analysis_jobs update failed:', error.message);
};

async function runJob(job) {
  await update(job.id, { status: 'running', started_at: new Date().toISOString() });
  let failed = 0;
  try {
    for (const stage of STAGES) {
      await update(job.id, { stage: stage.name, processed: 0, total: 0 });
      const result = await stage.run(job.page_id, {
        // called by a stage as it makes progress
        progress: (processed, total) => update(job.id, { processed, total }),
      });
      failed += result?.failed ?? 0;
      if (result?.tagged === 0 && result?.failed > 0) {
        throw new Error(`${stage.name}: all ${result.failed} items failed. Check the server log for the cause.`);
      }
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

// Queues a run and returns immediately. If one is already queued/running, returns that one.
export async function startAnalysis(pageId) {
  const current = await latestAnalysis(pageId);
  if (current.status === 'queued' || current.status === 'running') return current;

  const { data: job, error } = await db.from('analysis_jobs')
    .insert({ page_id: pageId }).select().single();
  if (error) throw error;
  runJob(job); // background: not awaited
  return job;
}

// Render restarts kill in-flight runs; mark them failed so the app shows Retry instead of spinning forever.
export async function failInterruptedJobs() {
  const { error } = await db.from('analysis_jobs').update({
    status: 'failed', error: 'Interrupted by a server restart', finished_at: new Date().toISOString(),
  }).in('status', ['queued', 'running']);
  if (error) console.error('could not clean up interrupted jobs:', error.message);
}
