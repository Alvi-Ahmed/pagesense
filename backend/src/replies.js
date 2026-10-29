import { db } from './db.js';
import { hasAuthorColumns } from './schema.js';

// Intents a seller should answer, most urgent first.
const NEEDS_REPLY = ['complaint', 'order_intent', 'price_question', 'size_or_color_request',
  'stock_or_restock', 'delivery_question', 'product_question', 'negotiation'];
const URGENT = new Set(['complaint', 'order_intent']);
const LIMIT = 8;

// Newest comments that need an answer: complaints and orders first. Comments the page already replied to
// are left out. `tracked` is false until a sync has recorded which comments the page wrote itself
// (migration 003 plus a re-sync); before that nothing can be marked answered.
export async function needsReply(pageId) {
  const columns = await hasAuthorColumns();
  let query = db.from('comments')
    .select('id, message, intent, size, color, created_time, post_id, posts!inner(page_id, message)')
    .eq('posts.page_id', pageId).in('intent', NEEDS_REPLY);
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
  const items = data.sort((a, b) => rank(a) - rank(b)).slice(0, LIMIT).map(({ posts, ...c }) => ({
    ...c, post_caption: (posts.message || '').slice(0, 80),
  }));
  return { items, shown: items.length, tracked };
}
