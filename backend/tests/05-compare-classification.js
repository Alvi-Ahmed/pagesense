// Classify the demo comments on every configured provider and compare speed, tokens, cost and agreement.
// Writes nothing to the database. Run: npm run test:compare   (optional: -- <limit> to use the first N comments)
import { db } from '../src/db.js';
import { completeJSON, PROVIDERS } from '../src/ai.js';
import { BATCH, classifiedRows, classifyRequest } from '../src/classify.js';

// USD per 1M tokens, from dev.meta.ai/docs/pricing-rate-limits (muse-spark-1.3, standard mode)
// and baseten.co/library/muse-spark-open. Cached-input discounts are ignored.
const PRICE = { meta: { in: 1.25, out: 4.25 }, baseten: { in: 1.25, out: 4.25 } };

const limit = Number(process.argv[2]) || 0;
const all = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from('comments').select('id, post_id, message, intent, posts!inner(page_id)')
    .eq('posts.page_id', 'demo').not('message', 'is', null).neq('message', '').order('id').range(from, from + 999);
  if (error) throw error;
  all.push(...data);
  if (data.length < 1000) break;
}
const comments = limit ? all.slice(0, limit) : all;
const stored = new Map(all.map((c) => [c.id, c.intent])); // what the earlier Meta run saved
console.log(`${comments.length} demo comments, batches of ${BATCH}`);

const runs = {};
for (const name of Object.keys(PROVIDERS)) {
  if (!PROVIDERS[name].client) { console.log(`[${name}] skipped: not configured`); continue; }
  const run = { rows: new Map(), ms: 0, calls: 0, failedCalls: 0, prompt: 0, completion: 0, reasoning: 0 };
  const started = Date.now();
  for (let i = 0; i < comments.length; i += BATCH) {
    const batch = comments.slice(i, i + BATCH);
    try {
      const r = await completeJSON('comment_classification', classifyRequest(batch), {
        provider: name, fallback: false,
        validate: (d) => { if (!Array.isArray(d?.comments)) throw new Error('no comments array'); },
      });
      run.calls++;
      run.prompt += r.usage?.prompt_tokens ?? 0;
      run.completion += r.usage?.completion_tokens ?? 0;
      run.reasoning += r.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      for (const row of classifiedRows(r.data.comments, batch)) run.rows.set(row.id, row);
    } catch (e) {
      run.failedCalls++;
      console.error(`[${name}] batch ${i / BATCH + 1} failed:`, e.status ?? '', JSON.stringify(e.error ?? e.message));
    }
    process.stdout.write('.');
  }
  run.ms = Date.now() - started;
  runs[name] = run;
  console.log(` ${name} done in ${(run.ms / 1000).toFixed(0)}s`);
}

const names = Object.keys(runs);
console.table(names.map((n) => {
  const r = runs[n];
  const usd = (r.prompt * PRICE[n].in + r.completion * PRICE[n].out) / 1e6;
  return {
    provider: n, classified: `${r.rows.size}/${comments.length}`, failed_calls: r.failedCalls, calls: r.calls,
    seconds: (r.ms / 1000).toFixed(0), sec_per_call: (r.ms / 1000 / Math.max(r.calls, 1)).toFixed(1),
    prompt_tokens: r.prompt, completion_tokens: r.completion, reasoning_tokens: r.reasoning,
    cost_usd: usd.toFixed(4), usd_per_1000_comments: ((usd / comments.length) * 1000).toFixed(4),
  };
}));

if (names.length > 1) {
  const [a, b] = names;
  const both = comments.filter((c) => runs[a].rows.has(c.id) && runs[b].rows.has(c.id));
  const diff = both.filter((c) => runs[a].rows.get(c.id).intent !== runs[b].rows.get(c.id).intent);
  console.log(`\nIntent agreement ${a} vs ${b}: ${both.length - diff.length}/${both.length} (${(((both.length - diff.length) / both.length) * 100).toFixed(1)}%)`);
  const pairs = {};
  for (const c of diff) { const k = `${runs[a].rows.get(c.id).intent} -> ${runs[b].rows.get(c.id).intent}`; pairs[k] = (pairs[k] || 0) + 1; }
  console.log('Most common disagreements (' + a + ' -> ' + b + '):');
  Object.entries(pairs).sort((x, y) => y[1] - x[1]).slice(0, 8).forEach(([k, n]) => console.log(`  ${String(n).padStart(3)}  ${k}`));
  for (const n of names) {
    const same = both.filter((c) => runs[n].rows.get(c.id).intent === stored.get(c.id)).length;
    console.log(`${n} matches the intents already saved in the database: ${same}/${both.length}`);
  }
  console.log(`\nExamples of disagreement (${a} | ${b} | comment):`);
  diff.slice(0, 15).forEach((c) => console.log(`  ${runs[a].rows.get(c.id).intent} | ${runs[b].rows.get(c.id).intent} | ${JSON.stringify(c.message.slice(0, 90))}`));
}
