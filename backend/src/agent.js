import { answerText, chatWithTools, parseJSON } from './ai.js';

export const MAX_TOOL_CALLS = Number(process.env.AGENT_MAX_TOOL_CALLS) || 8; // per run, including check_draft (the env var is for tests)
const EXTRA_TURNS = 6; // model replies beyond one per tool call: the final answer and any correction rounds
const MAX_FINAL_REJECTIONS = 2;

// ---- tools the model may call (all read-only) -------------------------------------------------
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const WHY_ITEMS = { type: 'array', items: obj({ ref: { type: 'string' }, reason: { type: 'string' } }, ['ref', 'reason']) };
const CHANGE_ITEMS = { type: 'array', items: obj({ change: { type: 'string' }, reason: { type: 'string' }, ref: { type: 'string' } }, ['change', 'reason', 'ref']) };

export const TOOLS = [
  { name: 'analyze_photo', description: 'What we can see in the product photo(s): product type, colors, style, worn or flat, background, photo problems, and anything that is only a guess. Use it to describe the product accurately.', parameters: obj() },
  { name: 'get_playbook_patterns', description: "What works on this seller's page, computed from their own posts: patterns (ids P1, P2...) with how many posts back each one, and recommended actions (ids A1, A2...). Your \"why\" reasons must cite these ids.", parameters: obj() },
  { name: 'find_similar_products', description: "How this seller's earlier posts about similar products did: number of posts, typical engagement, share that showed a price, worn vs flat photos.", parameters: obj({ product_type: { type: 'string', description: 'for example "sneakers"; leave out to use the current product' } }) },
  { name: 'get_customer_questions', description: 'What customers ask in their comments, as counts and shares per kind of question (price, size, stock, delivery...). Totals only: no comment text and no names.', parameters: obj() },
  { name: 'get_best_captions', description: "The seller's best captions, to copy their tone, length, emoji and layout (not their facts).", parameters: obj() },
  { name: 'check_draft', description: 'Check a draft against the grounding rules in code: numbers only from the known facts, placeholders for unknown facts, price shown when many customers ask it, no names, right language, valid reasons. Returns pass or fail with reasons. You must call this with your final caption and reasons, and fix and re-check until it passes.', parameters: obj({ caption: { type: 'string' }, why: WHY_ITEMS, changes: CHANGE_ITEMS, angle: { type: 'string', description: 'variants only: the angle of this variant' }, pattern: { type: 'string', description: 'variants only: the pattern id (P1...) this variant is based on' }, reason: { type: 'string', description: 'variants only: one plain sentence on how the caption uses that pattern' } }, ['caption']) },
].map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));

// ---- the trace, in plain words -----------------------------------------------------------------
const pct = (n) => `${Math.round(n)}%`;
const say = {
  analyze_photo: (r) => (r.available === false ? 'Looked for photo details: there were none for this product.'
    : `Looked at the product photo${r.product_phrase ? `: ${r.product_phrase}` : ''}.`),
  get_playbook_patterns: (r) => `Checked what works on your page${r.patterns?.[0] ? `, starting with "${r.patterns[0].pattern}: ${r.patterns[0].value}"` : ''} (${r.patterns?.length ?? 0} patterns, ${r.actions?.length ?? 0} tips).`,
  find_similar_products: (r) => (r.matches?.length ? `Looked at your earlier ${r.matches[0].product_type} posts: ${r.matches[0].posts} posts.` : 'Looked for similar products you posted before: found none.'),
  get_customer_questions: (r) => `Checked what customers ask${r.price_question_share_pct != null ? `: ${pct(r.price_question_share_pct)} of comments ask the price` : ''}.`,
  get_best_captions: (r) => `Read your ${r.captions?.length ?? 0} best captions to match your style.`,
  check_draft: (r, afterFailure) => (r.pass
    ? (afterFailure ? 'Fixed the draft and checked it again: it passed.' : 'Checked the draft against the rules: it passed.')
    : `Checked the draft against the rules: it broke ${r.problems.length === 1 ? 'a rule' : `${r.problems.length} rules`} (${r.problems[0]}).`),
};

const log = (event, fields) => console.log(JSON.stringify({ agent: true, ts: new Date().toISOString(), event, ...fields }));
const clipText = (v, n = 160) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
const briefArgs = (a) => Object.fromEntries(Object.entries(a || {}).map(([k, v]) => [k, typeof v === 'string' ? clipText(v) : Array.isArray(v) ? `[${v.length} items]` : v]));

// `plain` is the reason as shown to the owner; `message` (technical) only goes to the log
const stop = (message, trace, toolCalls, plain) => Object.assign(new Error(message), { trace, toolCalls, plain });

// ---- the loop ---------------------------------------------------------------------------------
// prompt: the task and rules. impls: tool name -> async (args) => result. check(caption, data) -> problems[]
// (the same checks that guard the single-call writer). finalSchemaHint is added to the closing instruction.
// Resolves { data, caption, trace, toolCalls } or throws an error carrying the trace so far.
// multi: { max, maxCalls, checkSet(items) -> problems[] } makes the final answer { variants: [...] }: every variant must
// have passed check_draft on its own, and the set is checked as a whole (distinct angles and patterns).
export async function runAgent({ runId, pageId, prompt, impls, check, shape, multi = null }) {
  const maxCalls = multi?.maxCalls ?? MAX_TOOL_CALLS;
  const maxTurns = maxCalls + EXTRA_TURNS;
  const messages = [{ role: 'user', content: prompt }];
  const trace = [];
  let calls = 0;
  let rejections = 0;
  let passed = null; // the last draft that check_draft passed
  const passedAll = new Map(); // multi: normalised caption -> what check_draft passed
  let lastCheckFailed = false;
  const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const started = Date.now();
    const res = await chatWithTools({ messages, tools: TOOLS });
    const msg = res.choices[0].message;
    log('turn', { runId, pageId, turn, finish: res.choices[0].finish_reason, tool_calls: msg.tool_calls?.length ?? 0, ms: Date.now() - started, usage: res.usage && { in: res.usage.prompt_tokens, out: res.usage.completion_tokens } });

    if (msg.tool_calls?.length) {
      // the docs require the full assistant message (with its tool_calls) before the tool results
      messages.push({
        role: 'assistant', content: msg.content ?? null,
        tool_calls: msg.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
      });
      for (const tc of msg.tool_calls) {
        if (calls >= maxCalls) throw stop(`reached the limit of ${maxCalls} tool calls`, trace, calls, 'it needed more steps than allowed');
        calls++;
        const name = tc.function.name;
        const t0 = Date.now();
        let args = {};
        let result;
        let ok = true;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          if (!impls[name]) throw new Error(`unknown tool "${name}"`);
          result = await impls[name](args);
          if (name === 'check_draft') {
            const caption = String(args.caption ?? '');
            passed = result.pass ? { caption: norm(caption), data: { caption, why: args.why, changes: args.changes } } : null;
            if (multi && result.pass) passedAll.set(norm(caption), { angle: args.angle, pattern: args.pattern, reason: args.reason });
            if (!result.pass) lastCheckFailed = true;
          }
        } catch (e) {
          ok = false;
          result = { error: e.message }; // the model sees the error and can recover; it still counts as a call
        }
        log('tool', { runId, pageId, n: calls, tool: name, args: briefArgs(args), ok, pass: result.pass, problems: result.problems, ms: Date.now() - t0 });
        trace.push({
          n: calls, tool: name, ok: ok && (name !== 'check_draft' || result.pass), ms: Date.now() - t0,
          text: ok ? say[name]?.(result, name === 'check_draft' && lastCheckFailed && result.pass) ?? `Used ${name}.` : `Tried ${name} and got an error, then carried on.`,
          ...(name === 'check_draft' && !result.pass && ok && { problems: result.problems }),
        });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }

    // no tool calls: this is the final answer
    let data;
    try { data = parseJSON(answerText(msg)); } catch (e) { data = null; log('final_unreadable', { runId, error: e.message }); }
    let why;
    if (multi) {
      const items = Array.isArray(data?.variants) ? data.variants.filter((v) => shape(v)) : [];
      const good = [];
      const problems = [];
      if (!items.length) problems.push('Your answer was not the JSON object asked for. Reply with ONLY that JSON.');
      for (const v of items) {
        const key = norm(v.caption);
        const seen = passedAll.get(key);
        if (!seen || seen.angle !== v.angle || seen.pattern !== v.pattern) { problems.push(`The "${v.angle}" variant has not been checked exactly as written: call check_draft with that caption, angle, pattern and reason first.`); continue; }
        const own = check(String(v.caption).trim(), v);
        if (own.length) { problems.push(`The "${v.angle}" variant does not pass: ${own.join('; ')}.`); continue; }
        good.push(v);
      }
      const setProblems = good.length ? multi.checkSet(good) : [];
      if (good.length && !problems.length && !setProblems.length) {
        trace.push({ n: calls + 1, tool: 'finish', ok: true, text: `Wrote ${good.length} caption ${good.length === 1 ? 'variant' : 'variants'}, each checked against the rules.`, ms: 0 });
        log('done', { runId, pageId, tool_calls: calls, turns: turn, variants: good.length });
        return { data: { variants: good }, variants: good, trace, toolCalls: calls };
      }
      why = [...problems, ...setProblems].join(' ');
      // out of correction rounds: keep the variants that did pass rather than lose them all
      if (good.length && rejections >= MAX_FINAL_REJECTIONS && !setProblems.length) {
        trace.push({ n: calls + 1, tool: 'finish', ok: true, text: `Kept the ${good.length} ${good.length === 1 ? 'variant' : 'variants'} that passed every check.`, ms: 0 });
        return { data: { variants: good }, variants: good, trace, toolCalls: calls };
      }
    } else {
    const caption = data && shape(data) ? String(data.caption).trim() : null;
    if (!caption) why = 'Your answer was not the JSON object asked for. Reply with ONLY that JSON.';
    else if (!passed || passed.caption !== norm(caption)) why = 'You have not checked this exact caption. Call check_draft with it and your reasons first, then answer.';
    else {
      const problems = check(caption, data);
      if (!problems.length) {
        trace.push({ n: calls + 1, tool: 'finish', ok: true, text: 'Wrote the final caption and reasons.', ms: 0 });
        log('done', { runId, pageId, tool_calls: calls, turns: turn });
        return { data, caption, trace, toolCalls: calls };
      }
      why = `That final answer does not pass: ${problems.join('; ')}. Fix it, call check_draft, then answer.`;
    }
    }
    if (++rejections > MAX_FINAL_REJECTIONS) throw stop('the final answer kept failing the checks', trace, calls, 'its draft kept breaking the rules');
    log('final_rejected', { runId, reason: why });
    messages.push({ role: 'assistant', content: msg.content ?? '' }, { role: 'user', content: why });
  }
  throw stop(`no final answer after ${maxTurns} turns`, trace, calls, 'it took too many turns');
}
