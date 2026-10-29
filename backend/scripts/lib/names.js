// Finds personal names written as plain text (Facebook only reports names that were tagged).
// Used by demo:export to remove them and by demo:scan to check nothing was missed.
import { clip, completeJSON } from '../../src/ai.js';

const BATCH = 60;
const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, names: { type: 'array', items: { type: 'string' } } },
        required: ['id', 'names'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You help anonymise Facebook comments and captions from a Bangladeshi shop. Texts may be Bangla script, English, Banglish, or other scripts.
For each text (an id and its text), list every PERSONAL NAME of a real person written in it: first names, full names, nicknames used as names, in any script (e.g. "Tahsina Islam Maisha", "সানজিদা হক প্রিয়া", "Ayesha").
Rules: copy each name EXACTLY as written, character for character. Do NOT list: brand or shop names, product names, places, honorifics or relations on their own (Apu, Apa, Bhai, Vai, Madam, ma'am, sir), words like "Customer 12" or "Demo Shop", or ordinary words. If a text has no personal names, return an empty list.
Return one object per text with the same id.`;

// items: [{ id, text }] -> Map(id -> [names that really occur in that text])
export async function findPersonalNames(items) {
  const found = new Map();
  const todo = items.filter((i) => i.text && i.text.trim());
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const input = batch.map((b) => `id: ${b.id}\ntext: ${clip(b.text, 600)}`).join('\n---\n');
    const { data } = await completeJSON('name_scan', {
      messages: [{ role: 'user', content: `${INSTRUCTIONS}\n\nTexts:\n${input}` }],
      response_format: { type: 'json_schema', json_schema: { name: 'names', schema: SCHEMA } },
    }, { validate: (d) => { if (!Array.isArray(d?.items)) throw new Error('answer has no "items" array'); } });
    const byId = new Map(batch.map((b) => [b.id, b.text]));
    for (const row of data.items) {
      const text = byId.get(row.id);
      const real = (row.names || []).map((n) => n.trim()).filter((n) => n.length >= 2 && text?.includes(n));
      if (real.length) found.set(row.id, real);
    }
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return found;
}
