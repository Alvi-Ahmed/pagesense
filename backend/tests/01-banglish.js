// Test 1: Can Muse Spark understand Banglish / Bangla seller comments?
// Run: npm run test:banglish
// Replace SAMPLE_COMMENTS with 20 real comments from a seller page for a true test.
import { meta, MODELS } from '../src/meta.js';

const SAMPLE_COMMENTS = [
  'price koto?',
  'XL ache?',
  'delivery charge koto dhakar baire?',
  'eta ki red color e pawa jabe',
  'ami 2 ta nibo, inbox check koren',
  'দাম কত ভাই?',
  'restock korben kobe?',
  'kapor ta ki pure cotton?',
  'last time product damage chilo, refund pai nai',
  'COD hobe?',
  'M size ta order korte chai, address dicchi',
  'sundor hoise 😍',
  'ei design ta ar ache?',
  'চট্টগ্রামে ডেলিভারি কয় দিনে?',
  'bhai 1200 taka beshi hoye geche, kom hobe?',
  'blue ta sold out?',
  'amar order ta ekhono pai nai 5 din hoye geche',
  'baby der size ache?',
  'Interested',
  'pic er moto e ki asol product?'
];

const INTENTS = ['price_question', 'size_or_color_request', 'stock_or_restock', 'order_intent',
  'delivery_question', 'product_question', 'complaint', 'negotiation', 'praise', 'other'];

const prompt = `You classify customer comments on a Facebook seller's page. Comments may be in Bangla script, English, or Banglish (Bangla written in English letters).

For each comment return an object with:
- "comment": the original text
- "intent": one of ${INTENTS.join(', ')}
- "size": size mentioned or null
- "color": color mentioned or null
- "english": a short English translation

Return ONLY a JSON array, no markdown fences.

Comments:
${SAMPLE_COMMENTS.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;

const started = Date.now();
const res = await meta.chat.completions.create({
  model: MODELS.spark,
  messages: [{ role: 'user', content: prompt }],
});

const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
let rows;
try {
  rows = JSON.parse(raw);
} catch {
  console.error('Could not parse JSON. Raw output:\n', raw);
  process.exit(1);
}

console.table(rows.map(r => ({ comment: r.comment, intent: r.intent, size: r.size, color: r.color, english: r.english })));
console.log(`\n${rows.length}/${SAMPLE_COMMENTS.length} classified in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('Usage:', res.usage);
console.log('\nCheck each row by hand. Aim for 18/20 correct before relying on it.');
