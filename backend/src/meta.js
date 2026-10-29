import 'dotenv/config';
import OpenAI from 'openai';

if (!process.env.MODEL_API_KEY) {
  throw new Error('MODEL_API_KEY is not set. Copy .env.example to .env and fill it in.');
}

// Meta Model API is OpenAI-compatible
export const meta = new OpenAI({
  baseURL: 'https://api.meta.ai/v1',
  apiKey: process.env.MODEL_API_KEY,
});

export const MODELS = {
  spark: 'muse-spark-1.3',
  image: 'muse-image-1.0',
  sam: 'sam-3.1',
};

// Bulk text work (classification, playbook) can run on Baseten's hosted Muse Spark open model when
// BASETEN_API_KEY is set. Any failure there falls back to muse-spark-1.3 on the Meta API.
const baseten = process.env.BASETEN_API_KEY && new OpenAI({
  baseURL: process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1',
  apiKey: process.env.BASETEN_API_KEY,
});

const BULK_PROVIDERS = [
  baseten && { name: 'baseten', client: baseten, model: 'meta-models/muse-spark-open-1026', extra: {} },
  // lowest muse-spark-1.3 accepts; "none" returns 400
  { name: 'meta', client: meta, model: MODELS.spark, extra: { reasoning_effort: 'minimal' } },
].filter(Boolean);

// Chat completion for bulk tasks. Returns the response; failures on the primary are logged with the body.
export async function bulkChat(params) {
  let lastErr;
  for (const p of BULK_PROVIDERS) {
    try {
      return await p.client.chat.completions.create({ ...params, model: p.model, ...p.extra });
    } catch (err) {
      lastErr = err;
      console.error(`bulk call failed on ${p.name}:`, err.status ?? '', JSON.stringify(err.error ?? err.message));
    }
  }
  throw lastErr;
}
