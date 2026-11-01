import { db } from './db.js';
import { hasAuthorColumns } from './schema.js';
import { commentUrl } from './orders.js';

// Intents a seller should answer, most urgent first.
const NEEDS_REPLY = ['complaint', 'order_intent', 'price_question', 'size_or_color_request',
  'stock_or_restock', 'delivery_question', 'product_question', 'negotiation'];
const URGENT = new Set(['complaint', 'order_intent']);
const LIMIT = 8;
const MAX_LIMIT = 40;

// Newest comments that need an answer: complaints and orders first. Comments the page already replied to
// are left out. `tracked` is false until a sync has recorded which comments the page wrote itself
// (migration 003 plus a re-sync); before that nothing can be marked answered.
// `intent` narrows the list to one kind (the Home tiles link here); `limit` is how many to show.
export async function needsReply(pageId, { intent, limit } = {}) {
  const columns = await hasAuthorColumns();
  const kinds = NEEDS_REPLY.includes(intent) ? [intent] : NEEDS_REPLY;
  let query = db.from('comments')
    .select('id, message, intent, size, color, created_time, post_id, posts!inner(page_id, message)')
    .eq('posts.page_id', pageId).in('intent', kinds);
  if (columns) query = query.eq('is_page', false).eq('answered', false);
  const { data, error } = await query.order('created_time', { ascending: false }).limit(300);
  if (error) throw error;

  let tracked = false;
  if (columns) {
    const { count, error: err } = await db.from('comments').select('id, posts!inner(page_id)', { count: 'exact', head: true })
      .eq('posts.page_id', pageId).eq('is_page', true);
    if (err) throw err;
    tracked = count > 0;
  }
  const rank = (c) => (URGENT.has(c.intent) ? 0 : 1);
  const sorted = data.sort((a, b) => rank(a) - rank(b));
  const items = sorted.slice(0, Math.min(Number(limit) || LIMIT, MAX_LIMIT)).map(({ posts, ...c }) => ({
    ...c, post_caption: (posts.message || '').slice(0, 80), comment_url: commentUrl(c.post_id, c.id),
  }));
  return { items, shown: items.length, total: sorted.length, tracked };
}
