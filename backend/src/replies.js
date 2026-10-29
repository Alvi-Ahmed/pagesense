import { db } from './db.js';

// Intents a seller should answer, most urgent first.
const NEEDS_REPLY = ['complaint', 'order_intent', 'price_question', 'size_or_color_request',
  'stock_or_restock', 'delivery_question', 'product_question', 'negotiation'];
const URGENT = new Set(['complaint', 'order_intent']);
const LIMIT = 8;

// Newest comments that need an answer: complaints and orders first. Facebook comments carry no author,
// so replies the seller already sent cannot be told apart yet.
export async function needsReply(pageId) {
  const { data, error } = await db.from('comments')
    .select('id, message, intent, size, color, created_time, post_id, posts!inner(page_id, message)')
    .eq('posts.page_id', pageId).in('intent', NEEDS_REPLY)
    .order('created_time', { ascending: false }).limit(300);
  if (error) throw error;
  const rank = (c) => (URGENT.has(c.intent) ? 0 : 1);
  const items = data.sort((a, b) => rank(a) - rank(b)).slice(0, LIMIT).map(({ posts, ...c }) => ({
    ...c, post_caption: (posts.message || '').slice(0, 80),
  }));
  return { items, shown: items.length };
}
