import OpenAI from 'openai';
import { meta, MODELS } from './meta.js';

// Where each AI task runs. BULK_PROVIDER switches every bulk task at once; PROVIDER_<TASK> overrides one.
// Baseten (Muse Spark Open) is the default for bulk work; set BULK_PROVIDER=meta to move everything back.
const BULK = process.env.BULK_PROVIDER || 'baseten';
export const TASKS = {
  comment_classification: { provider: process.env.PROVIDER_COMMENT_CLASSIFICATION || BULK, lowEffort: true },
  post_tagging: { provider: process.env.PROVIDER_POST_TAGGING || BULK, lowEffort: true },
  playbook: { provider: process.env.PROVIDER_PLAYBOOK || BULK, lowEffort: true },
  photo_analysis: { provider: process.env.PROVIDER_PHOTO_ANALYSIS || BULK, lowEffort: true },
  name_scan: { provider: process.env.PROVIDER_NAME_SCAN || BULK, lowEffort: true },
  post_generation: { provider: process.env.PROVIDER_POST_GENERATION || 'meta', lowEffort: false },
};

// lowestEffort is the smallest reasoning_effort each provider accepts:
// Meta rejects "none" (400); Baseten maps "none"/"minimal" to "low", and Muse Spark Open always reasons.
export const PROVIDERS = {
  meta: { client: meta, model: MODELS.spark, lowestEffort: 'minimal' },
  baseten: {
    client: process.env.BASETEN_API_KEY && new OpenAI({
      baseURL: process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1',
      apiKey: process.env.BASETEN_API_KEY,
    }),
    model: process.env.BASETEN_MODEL || 'meta-models/muse-spark-open',
    lowestEffort: 'low',
  },
};

// Cut text to n characters without splitting an emoji's surrogate pair (a lone half makes the request body invalid JSON).
export const clip = (text, n) => Array.from(String(text ?? '').toWellFormed()).slice(0, n).join('');

// Reasoning models return their thinking in message.reasoning_content; only message.content is the answer.
// Some builds put <think>…</think> inside content instead, so strip that too.
function finalAnswer(message) {
  const text = (message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) throw new Error('model returned no final answer (empty content)');
  return text;
}

// Structured output is not enforced by every model (Muse Spark Open accepts json_schema but ignores it),
// so tolerate code fences and surrounding prose.
export function parseJSON(text) {
  const bare = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(bare); } catch { /* fall through to extraction */ }
  const start = bare.search(/[[{]/);
  const end = Math.max(bare.lastIndexOf(']'), bare.lastIndexOf('}'));
  if (start < 0 || end < start) throw new Error('model answer is not JSON');
  return JSON.parse(bare.slice(start, end + 1));
}

async function call(providerName, task, params) {
  const p = PROVIDERS[providerName];
  if (!p?.client) throw new Error(`provider "${providerName}" is not configured (missing API key)`);
  const started = Date.now();
  const res = await p.client.chat.completions.create({
    ...params, model: p.model, ...(task.lowEffort && { reasoning_effort: p.lowestEffort }),
  });
  const choice = res.choices[0];
  if (choice.finish_reason === 'length') throw new Error('model ran out of tokens before finishing its answer');
  return {
    data: parseJSON(finalAnswer(choice.message)),
    provider: providerName, model: p.model, ms: Date.now() - started, usage: res.usage,
    reasoningChars: (choice.message.reasoning_content || choice.message.reasoning || '').length,
  };
}

// One JSON-returning model call for a task, on the provider the config maps it to.
// If that provider fails, rate-limits, or returns something unusable (validate throws), the call is logged
// and repeated once on muse-spark-1.3 on the Meta API. Options: { validate, provider, fallback: false }.
export async function completeJSON(taskName, params, { validate, provider, fallback = true } = {}) {
  const task = TASKS[taskName];
  if (!task) throw new Error(`unknown AI task "${taskName}"`);
  const name = provider || task.provider;
  try {
    const result = await call(name, task, params);
    validate?.(result.data);
    return result;
  } catch (err) {
    if (name === 'meta' || !fallback) throw err;
    console.error(`${taskName}: ${name} failed, falling back to meta (${MODELS.spark}):`,
      err.status ?? '', JSON.stringify(err.error ?? err.message));
    const result = await call('meta', task, params);
    validate?.(result.data);
    return { ...result, fellBackFrom: name };
  }
}
