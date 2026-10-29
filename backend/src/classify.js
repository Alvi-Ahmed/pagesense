import { db } from './db.js';
import { clip, completeJSON } from './ai.js';
import { hasAuthorColumns } from './schema.js';

const BATCH_SIZE = 75; // 50–100 per request keeps the number of reasoning-heavy calls small

export const INTENTS = ['price_question', 'size_or_color_request', 'stock_or_restock', 'order_intent',
  'interested', 'delivery_question', 'product_question', 'complaint', 'negotiation', 'praise', 'other'];

const SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          intent: { type: 'string', enum: INTENTS },
          size: { type: 'string' },
          color: { type: 'string' },
        },
        required: ['id', 'intent', 'size', 'color'],
        additionalProperties: false,
      },
    },
  },
  required: ['comments'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You classify customer comments on a small seller's Facebook product posts. Comments may be Bangla script, English, or Banglish (Bangla in English letters), and are often very short ("Pp", "price", "dam koto", "inbox").
For each comment (an id and its text) return one object with:
- id: copied exactly from the input
- intent: exactly one of:
  price_question (asks the price, "pp", "dam koto"), size_or_color_request (asks for or states a size/color wanted), stock_or_restock (asks if available or when back in stock),
  order_intent (wants to buy: "I want this", "order korbo", gives an address or phone), interested (shows interest without a question), delivery_question (delivery time, charge, area, cash on delivery),
  product_question (fabric, quality, measurements, other product details), complaint (unhappy with product, delay, service), negotiation (asks for a discount or lower price),
  praise (compliment only), other (tags, greetings, spam, unclear)
- size: the size the customer mentions (e.g. "M", "XL", "42"), or "" if none
- color: the color the customer mentions in English (e.g. "red"), or "" if none
Return one object per comment, in the same order.`;

export const BATCH = BATCH_SIZE;

// The model request for a batch of comments; also used by the provider comparison script.
export function classifyRequest(comments) {
  const input = comments.map((c) => `id: ${c.id}\ntext: ${clip(c.message, 500)}`).join('\n---\n');
  return {
    messages: [{ role: 'user', content: `${INSTRUCTIONS}\n\nComments:\n${input}` }],
    response_format: { type: 'json_schema', json_schema: { name: 'comment_intents', schema: SCHEMA } },
  };
}
const validAnswer = (d) => { if (!Array.isArray(d?.comments)) throw new Error('answer has no "comments" array'); };

// Model answer -> rows for the comments table. Ids the model skipped or invented are dropped.
export function classifiedRows(out, comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const seen = new Set();
  return out
    .filter((r) => byId.has(r.id) && INTENTS.includes(r.intent) && !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({
      id: r.id, post_id: byId.get(r.id).post_id, intent: r.intent,
      size: r.size?.trim() || null, color: r.color?.trim() || null,
    }));
}

async function classifyBatch(comments) {
  const { data } = await completeJSON('comment_classification', classifyRequest(comments), { validate: validAnswer });
  return classifiedRows(data.comments, comments);
}

async function fetchAll(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

// Comments with text and no intent yet. Empty comments (stickers, photos) cannot be classified,
// and neither can the page's own replies: they are not customers.
async function unclassified(pageId) {
  const skipPage = await hasAuthorColumns();
  return fetchAll(() => {
    const q = db.from('comments').select('id, post_id, message, posts!inner(page_id)')
      .eq('posts.page_id', pageId).is('intent', null).not('message', 'is', null).neq('message', '').order('id');
    return skipPage ? q.eq('is_page', false) : q;
  });
}

async function save(rows) {
  const { error } = await db.from('comments').upsert(rows);
  if (error) throw new Error(`comments: ${error.message}`);
}

// Analysis stage: classifies every unclassified comment, reporting progress as it goes.
export async function classifyPage(pageId, { progress } = {}) {
  const todo = await unclassified(pageId);
  let classified = 0;
  let failed = 0;
  await progress?.(0, todo.length);
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    try {
      const rows = await classifyBatch(batch);
      await save(rows);
      classified += rows.length;
      failed += batch.length - rows.length; // comments the model left out; retried on the next run
    } catch (e) {
      failed += batch.length;
      console.error('classify batch failed:', e.message);
    }
    await progress?.(Math.min(i + BATCH_SIZE, todo.length), todo.length);
  }
  return { classified, failed, total: todo.length };
}
