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
