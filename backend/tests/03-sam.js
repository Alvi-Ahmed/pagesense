// Test 3: Can SAM 3.1 find the product in a seller photo? (We only need the box for logo placement.)
// Run: npm run test:sam -- tests/images/product.jpg "dress"
import fs from 'node:fs';
import path from 'node:path';
import { meta, MODELS } from '../src/meta.js';

const [imgPath = 'tests/images/product.jpg', phrase = 'product'] = process.argv.slice(2);
if (!fs.existsSync(imgPath)) {
  console.error(`Put a seller product photo at ${imgPath} (or pass a path).`);
  process.exit(1);
}

const ext = path.extname(imgPath).slice(1).toLowerCase().replace('jpg', 'jpeg');
const dataUrl = `data:image/${ext};base64,${fs.readFileSync(imgPath).toString('base64')}`;

// NOTE: request shape follows the OpenAI-style Responses API. If it errors, compare with
// the "Media segmentation" guide at dev.meta.ai/docs and adjust the content block types.
const res = await meta.responses.create({
  model: MODELS.sam,
  input: [{
    role: 'user',
    content: [
      { type: 'input_text', text: phrase },
      { type: 'input_image', image_url: dataUrl },
    ],
  }],
});

const text = res.output_text || JSON.stringify(res.output ?? '');
// SAM 3.1 returns special-token text like: id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;...|>
const boxes = [...text.matchAll(/<\|box;([^|]*)\|>/g)].map(m =>
  Object.fromEntries(m[1].split(';').map(kv => kv.split('=')).map(([k, v]) => [k, Number(v)]))
);

if (!boxes.length) {
  console.log('No boxes parsed. Raw output (first 500 chars):\n', text.slice(0, 500));
  console.log('Full response object:\n', JSON.stringify(res, null, 2).slice(0, 3000));
  process.exit(1);
}

console.table(boxes.map((b, i) => ({
  object: i,
  x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2,
  coversPctOfImage: (((b.x2 - b.x1) * (b.y2 - b.y1)) / (b.w * b.h) * 100).toFixed(1) + '%',
})));
console.log(`Found ${boxes.length} "${phrase}" object(s). Empty space outside these boxes is where the logo goes.`);
