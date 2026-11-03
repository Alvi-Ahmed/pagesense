// Seed the demo page's Messenger orders and leads. demo/messages.json holds made-up chats for "Demo Shop" (never real
// customers); they go through the SAME reading as a real page's chats (Muse Spark judges each chat, every detail is
// checked against what the customer wrote), so the demo shows what PageSense really does.
// Needs db/011_message_orders.sql. Replaces the demo's chat orders. Run: npm run demo:messages
import fs from 'node:fs';
import { db } from '../src/db.js';
import { createOrdersFromMessages } from '../src/orders.js';

const chats = JSON.parse(fs.readFileSync(new URL('../demo/messages.json', import.meta.url), 'utf8'));
const now = Date.now();
const conversations = chats.map((c) => {
  const messages = c.chat.map(([from, text, hoursAgo]) => ({ from, text, at: new Date(now - hoursAgo * 3600_000).toISOString() }));
  return { id: c.id, updated_time: messages.at(-1).at, messages };
});

for (const table of ['orders', 'conversation_checks']) {
  const q = db.from(table).delete().eq('page_id', 'demo'); // never anything but the demo page
  const { error } = table === 'orders' ? await q.eq('source', 'message') : await q;
  if (error) throw new Error(`${table}: ${error.message}`);
}
const r = await createOrdersFromMessages('demo', { conversations });
console.log(`demo chat orders: ${r.created} (${r.orders} orders, ${r.leads} leads) from ${r.total} chats, ${r.failed} failed`);
