import { db } from './db.js';
import { graph, paginate } from './facebook.js';
import { startAnalysis } from './analysis.js';
import { DEMO_PAGE_ID } from './demo.js';
import { hasAuthorColumns } from './schema.js';

// Score weights: shares and comments say more about buying intent than a reaction.
export const engagementScore = ({ reactions, comments_count, shares }) =>
  reactions + 2 * comments_count + 3 * shares;

const COMMENT_CONCURRENCY = 5; // posts whose comments are fetched at the same time

const POST_FIELDS = [
  'id', 'message', 'created_time', 'full_picture', 'shares',
  'reactions.summary(total_count).limit(0)',
  'comments.summary(true).limit(0)',
].join(',');

// In-memory progress per page. Fine for a single Render instance; lost on restart.
const jobs = new Map();

export const getSyncStatus = (pageId) => jobs.get(pageId) || { status: 'idle' };

async function upsert(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + 500));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

function toPostRow(pageId, p) {
  const row = {
    id: p.id,
    page_id: pageId,
    message: p.message ?? null,
    photo_url: p.full_picture ?? null,
    created_time: p.created_time,
    reactions: p.reactions?.summary?.total_count ?? 0,
    comments_count: p.comments?.summary?.total_count ?? 0,
    shares: p.shares?.count ?? 0,
  };
  row.engagement_score = engagementScore(row);
  return row; // is_boosted is omitted so a sync never overwrites it
}

// A comment is answered when the page itself replied to it: directly, or later in the same thread
// (Facebook threads are two levels: replies all point at the top-level comment).
export function markAnswered(rows) {
  const pageReplies = rows.filter((r) => r.is_page && r.parent_id);
  const repliedTo = new Set(pageReplies.map((r) => r.parent_id));
  const lastReplyInThread = new Map();
  for (const r of pageReplies) {
    const prev = lastReplyInThread.get(r.parent_id);
    if (!prev || r.created_time > prev) lastReplyInThread.set(r.parent_id, r.created_time);
  }
  return rows.map((r) => ({
    ...r,
    answered: !r.is_page && (repliedTo.has(r.id) || (!!r.parent_id && lastReplyInThread.get(r.parent_id) > r.created_time)),
  }));
}

// Before migration 003 the new columns do not exist; drop them so the sync still works.
async function withAuthorColumns(rows) {
  if (await hasAuthorColumns()) return rows;
  return rows.map(({ parent_id, is_page, answered, ...rest }) => rest); // eslint-disable-line no-unused-vars
}

async function syncComments(pageId, postId, token, job) {
  // intent/size/color are omitted so a re-sync keeps earlier classification.
  // filter=stream lists replies as rows of their own with parent{id}; from{id} is only returned for the page's own comments.
  const rows = [];
  for await (const batch of paginate(`/${postId}/comments`, {
    access_token: token,
    fields: 'id,message,created_time,from{id},parent{id}',
    filter: 'stream',
    limit: '100',
  })) {
    rows.push(...batch.map((c) => ({
      id: c.id, post_id: postId, message: c.message ?? null, created_time: c.created_time,
      parent_id: c.parent?.id ?? null, is_page: c.from?.id === pageId,
    })));
    job.comments += batch.length;
    job.updatedAt = Date.now();
  }
  // all replies of a post are in memory before answers are worked out, since a reply can land on a later page
  await upsert('comments', await withAuthorColumns(markAnswered(rows)));
}

async function run(pageId, token, job) {
  for await (const batch of paginate(`/${pageId}/posts`, {
    access_token: token,
    fields: POST_FIELDS,
    limit: '50',
    // Graph stops paging once posts get older than `since`; omitted = full history
    ...(job.days && { since: String(Math.floor(Date.now() / 1000) - job.days * 86400) }),
  })) {
    const rows = batch.map((p) => toPostRow(pageId, p));
    await upsert('posts', rows);
    job.posts += rows.length;
    job.updatedAt = Date.now();

    const queue = rows.filter((r) => r.comments_count > 0);
    job.commentsExpected += queue.reduce((n, r) => n + r.comments_count, 0);
    // Small worker pool: comment paging is the slow part and posts are independent.
    await Promise.all(Array.from({ length: COMMENT_CONCURRENCY }, async () => {
      for (let row; (row = queue.shift());) await syncComments(pageId, row.id, token, job);
    }));
  }
}

// Starts a background sync and returns immediately. One sync per page at a time.
// `days` limits history to the last N days (cheaper); falsy syncs everything.
export async function startSync(pageId, days) {
  if (jobs.get(pageId)?.status === 'running') return jobs.get(pageId);
  if (pageId === DEMO_PAGE_ID) {
    throw Object.assign(new Error('The demo page is a fixed snapshot and cannot be synced'), { status: 400 });
  }

  const { data: page, error } = await db.from('pages').select('access_token').eq('id', pageId).maybeSingle();
  if (error) throw error;
  if (!page) {
    const err = new Error('Page not connected');
    err.status = 404;
    throw err;
  }

  const job = { status: 'running', days: days || null, posts: 0, comments: 0, commentsExpected: 0, updatedAt: Date.now(), startedAt: new Date().toISOString() };
  jobs.set(pageId, job);
  run(pageId, page.access_token, job)
    .then(async () => {
      job.status = 'done';
      // stages run for the new posts and comments after every successful sync; their failure must not mark the sync failed
      await startAnalysis(pageId, { source: 'sync' }).catch((e) => console.error('could not start analysis:', e.message));
    })
    .catch((e) => { console.error('sync failed', pageId, e.message); job.status = 'error'; job.error = e.message; })
    .finally(() => { job.finishedAt = new Date().toISOString(); });
  return job;
}
