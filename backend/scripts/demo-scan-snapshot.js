// Look for personal data left in demo/snapshot.json: names, phone numbers, emails, links, addresses.
// Run: npm run demo:scan   (set KNOWN_NAMES=/path/names.json to also check a private list of real names)
import fs from 'node:fs';
import { findPersonalNames } from '../src/names.js';

const snap = JSON.parse(fs.readFileSync(new URL('../demo/snapshot.json', import.meta.url), 'utf8'));
const texts = [
  ...snap.posts.map((p) => ({ id: p.id, text: p.message })),
  ...snap.comments.map((c) => ({ id: c.id, text: c.message })),
].filter((t) => t.text);

const checks = {
  'phone number (9+ digits)': (t) => (t.match(/[\d০-৯][\d০-৯ \t\-().]{6,}[\d০-৯]/g) || []).filter((m) => m.replace(/[^\d০-৯]/g, '').length >= 9),
  'email': (t) => t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [],
  'link': (t) => t.match(/https?:\/\/\S+|\bwww\.\S+/gi) || [],
  'shop brand name': (t) => t.match(/mega\s*genie/gi) || [],
  '@mention': (t) => t.match(/@\w\S*/g)?.filter((m) => m !== '@customer') || [],
  'address word': (t) => t.match(/\b(road|rd\.?|house|flat|sector|block|avenue|lane|floor|thana|upazila|zilla|dhaka|chattogram|chittagong|sylhet|khulna|rajshahi|mirpur|uttara|dhanmondi|gulshan|banani|mohammadpur|bashundhara|bazar|market)\b|রোড|বাড়ি|ফ্ল্যাট|সেক্টর|ব্লক|থানা|এলাকা|মার্কেট/gi) || [],
};

const report = {};
for (const { id, text } of texts) {
  for (const [kind, fn] of Object.entries(checks)) {
    const hits = fn(text);
    if (hits.length) (report[kind] ||= []).push(`${id}: ${hits.join(' | ')}  <- ${JSON.stringify(text.slice(0, 70))}`);
  }
}

// real names from the export, if the maintainer kept the private list
if (process.env.KNOWN_NAMES) {
  const known = JSON.parse(fs.readFileSync(process.env.KNOWN_NAMES, 'utf8'));
  const blob = texts.map((t) => t.text.toLowerCase()).join('\n');
  const leaked = known.filter((n) => n.length >= 3 && blob.includes(n));
  report['known real name still present'] = leaked.map((n) => n);
  console.log(`checked ${known.length} known names: ${leaked.length} still present`);
}

console.log('asking Muse Spark for any remaining personal names...');
const names = await findPersonalNames(texts);
if (names.size) report['personal name found by model'] = [...names].map(([id, n]) => `${id}: ${n.join(' | ')}  <- ${JSON.stringify(texts.find((t) => t.id === id).text.slice(0, 70))}`);

let total = 0;
for (const [kind, rows] of Object.entries(report)) {
  total += rows.length;
  console.log(`\n${kind}: ${rows.length}`);
  rows.slice(0, 25).forEach((r) => console.log('  ' + r));
}
console.log(total ? `\n${total} possible leaks to review` : '\nnothing found');
