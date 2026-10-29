// Test 1: Can Muse Spark understand Banglish / Bangla seller comments?
// Run: npm run test:banglish                      (every configured provider, side by side)
//      npm run test:banglish -- meta              (one provider)
// Replace SAMPLE_COMMENTS with 20 real comments from a seller page for a true test.
import { completeJSON, PROVIDERS } from '../src/ai.js';

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

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROVIDERS);
const results = {};

for (const name of names) {
  if (!PROVIDERS[name]?.client) { console.log(`\n[${name}] skipped: not configured (set BASETEN_API_KEY in .env)`); continue; }
  try {
    // fallback: false, so a Baseten failure shows up here instead of being hidden by the Meta fallback
    const r = await completeJSON('comment_classification',
      { messages: [{ role: 'user', content: prompt }] }, { provider: name, fallback: false });
    results[name] = r;
  } catch (err) {
    console.error(`\n[${name}] FAILED:`, err.status ?? '', JSON.stringify(err.error ?? err.message));
  }
}

const ran = Object.keys(results);
if (!ran.length) process.exit(1);

// Rows are matched by position: each model returns one object per comment, in order.
console.table(SAMPLE_COMMENTS.map((comment, i) => {
  const row = { comment };
  for (const n of ran) { const x = results[n].data[i]; row[n] = x ? [x.intent, x.size, x.color].filter(Boolean).join(' / ') : '(missing)'; }
  if (ran.length > 1) row.agree = results[ran[0]].data[i]?.intent === results[ran[1]].data[i]?.intent ? '' : 'DIFF';
  return row;
}));

console.table(ran.map((n) => {
  const r = results[n];
  return {
    provider: n, model: r.model, rows: `${r.data.length}/${SAMPLE_COMMENTS.length}`, seconds: (r.ms / 1000).toFixed(1),
    prompt_tokens: r.usage?.prompt_tokens, completion_tokens: r.usage?.completion_tokens, total_tokens: r.usage?.total_tokens,
    reasoning_tokens: r.usage?.completion_tokens_details?.reasoning_tokens ?? '',
    reasoning_chars_dropped: r.reasoningChars,
  };
}));
if (ran.length > 1) {
  const diff = SAMPLE_COMMENTS.filter((_, i) => results[ran[0]].data[i]?.intent !== results[ran[1]].data[i]?.intent).length;
  console.log(`Intent disagreements between ${ran[0]} and ${ran[1]}: ${diff}/${SAMPLE_COMMENTS.length}`);
}
console.log('\nCheck each row by hand. Aim for 18/20 correct before relying on it.');
