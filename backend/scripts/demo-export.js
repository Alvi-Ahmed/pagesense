// Snapshot a real page into demo/snapshot.json for demo mode: ids anonymised, customer names removed.
// Posts: the newest photo posts (the whole history if the page has under ~300), no hand-picked top posts.
// Comments are fetched fresh from Facebook with author and parent fields, so the demo can show which
// comments the page already answered. AI results (tags, intents, playbook) are not copied: run
// `npm run demo:seed -- --reset`, run analysis, then `npm run demo:save-analysis`.
// Run: npm run demo:export [-- <pageId>]   (default: the real page with the most posts)
import fs from 'node:fs';
import { db } from '../src/db.js';
import { graph, paginate } from '../src/facebook.js';
import { markAnswered } from '../src/sync.js';
import { findPersonalNames } from '../src/names.js';

const NEWEST = 150;
const WHOLE_HISTORY_UNDER = 300;
const THREADS_PER_POST = 40; // top-level comments kept per post, each with all of its replies

const fetchAll = async (build) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
};

let pageId = process.argv[2];
if (!pageId) {
  const { data } = await db.from('pages').select('id').neq('id', 'demo');
  if (!data?.length) throw new Error('No synced page found');
  let best = -1;
  for (const p of data) {
    const { count } = await db.from('posts').select('*', { count: 'exact', head: true }).eq('page_id', p.id);
    if (count > best) { best = count; pageId = p.id; }
  }
}
if (pageId === 'demo') throw new Error('Refusing to snapshot the demo page itself');
const { data: page } = await db.from('pages').select('id, name, access_token').eq('id', pageId).single();

const photoPosts = await fetchAll(() => db.from('posts').select('*').eq('page_id', pageId).not('photo_url', 'is', null).order('id'));
const byTime = [...photoPosts].sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
const chosen = photoPosts.length < WHOLE_HISTORY_UNDER ? byTime : byTime.slice(0, NEWEST);
console.log(`page "${page.name}": ${photoPosts.length} photo posts, exporting ${chosen.length} (${chosen.at(-1).created_time.slice(0, 10)} to ${chosen[0].created_time.slice(0, 10)})`);

// ---- fresh data from Facebook ------------------------------------------------------------
const fresh = new Map(); // post id -> { full_picture, message, message_tags }
const queue = [...chosen]; // the ids= batch parameter is deprecated in Graph v26, so one call per post
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let p; (p = queue.shift());) {
    fresh.set(p.id, await graph(`/${p.id}`, { access_token: page.access_token, fields: 'full_picture,message,message_tags' }));
  }
}));

const rawComments = []; // { postId, row, tags }
for (const [n, p] of chosen.entries()) {
  const rows = [];
  for await (const batch of paginate(`/${p.id}/comments`, {
    access_token: page.access_token,
    fields: 'id,message,message_tags,created_time,from{id},parent{id}',
    filter: 'stream', limit: '100',
  })) {
    rows.push(...batch.map((c) => ({
      id: c.id, message: c.message ?? null, created_time: c.created_time, tags: c.message_tags || [],
      parent_id: c.parent?.id ?? null, is_page: c.from?.id === pageId,
    })));
  }
  const answered = new Map(markAnswered(rows).map((r) => [r.id, r.answered]));
  // keep whole threads: the newest top-level comments and every reply under them
  const top = rows.filter((r) => !r.parent_id).sort((a, b) => b.created_time.localeCompare(a.created_time)).slice(0, THREADS_PER_POST);
  const keep = new Set(top.map((r) => r.id));
  for (const r of rows) if (keep.has(r.parent_id ?? r.id)) rawComments.push({ postId: p.id, ...r, answered: answered.get(r.id) });
  if ((n + 1) % 25 === 0) console.log(`  comments fetched for ${n + 1}/${chosen.length} posts`);
}

// ---- remove people ----------------------------------------------------------------------
// Tagged people ("Nurani Esha check inbox", "tag a friend") get stable aliases: Customer 1, Customer 2, ...
// The page's own name becomes "Demo Shop". The same names are also replaced where they appear untagged.
const aliases = new Map(); // fb tag id -> alias
const nameToAlias = new Map(); // lower-cased name -> alias
// Aliases are written as placeholders (\uE000 + number + \uE001) so the number scrub cannot merge their digits
// with a price; they become "Customer N" at the very end.
const PERSON = (n) => `\uE000${n}\uE001`;
const aliasFor = (tag) => {
  // the page is sometimes tagged under another id, so match its name as well
  if (tag.id === pageId || tag.name?.trim().toLowerCase() === page.name.toLowerCase()) return 'Demo Shop';
  if (!aliases.has(tag.id)) aliases.set(tag.id, tag.type === 'page' ? 'Another page' : PERSON(aliases.size + 1));
  const alias = aliases.get(tag.id);
  if (tag.name && tag.name.trim().length >= 3) nameToAlias.set(tag.name.trim().toLowerCase(), alias);
  return alias;
};
nameToAlias.set(page.name.toLowerCase(), 'Demo Shop');

// Tagged names are registered here and removed by name match below. (Slicing by the tag's offset/length would
// depend on whether Facebook counts UTF-16 units or code points, and emoji make those differ.)
const registerTags = (text, tags = []) => { for (const t of tags) aliasFor(t); return text; };
// Phone-like runs need 9+ digits, so prices ("1250 1300") survive.
const genericScrub = (text) => text
  .replace(/https?:\/\/\S+|\bwww\.\S+/gi, '[link]')
  .replace(/mega\s*genie\w*/gi, 'Demo Shop') // the shop's name, also inside domains and handles
  .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
  .replace(/\+?[\d০-৯][\d০-৯ \t\-().]{6,}[\d০-৯]/g, (m) => (m.replace(/[^\d০-৯]/g, '').length >= 9 ? '[number]' : m))
  .replace(/@\S+/g, '@customer');

// pass 1 registers every tagged name; pass 2 removes names wherever they still appear as plain text
const original = {
  posts: chosen.map((p) => registerTags(fresh.get(p.id)?.message ?? p.message, fresh.get(p.id)?.message_tags)),
  comments: rawComments.map((c) => registerTags(c.message, c.tags)),
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const replaceNames = (t) => {
  if (t == null) return null;
  const names = [...nameToAlias.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return t;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${names.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return t.replace(re, (m) => nameToAlias.get(m.toLowerCase()));
};
const stage1 = { posts: original.posts.map(replaceNames), comments: original.comments.map(replaceNames) };
// Names written as plain text, found by Muse Spark in the already de-tagged text.
console.log('looking for untagged names...');
const items = [
  ...stage1.posts.map((text, i) => ({ id: `p${i}`, text })),
  ...stage1.comments.map((text, i) => ({ id: `c${i}`, text })),
];
let untagged = 0;
for (const names of (await findPersonalNames(items)).values()) {
  for (const n of names) {
    if (nameToAlias.has(n.toLowerCase())) continue;
    nameToAlias.set(n.toLowerCase(), PERSON(aliases.size + 1 + untagged++));
  }
}
console.log(`${untagged} more names found in plain text`);

const finalText = (t) => {
  if (t == null) return null;
  return genericScrub(replaceNames(t).toWellFormed()).replace(/\uE000(\d+)\uE001/g, 'Customer $1');
};

// ---- build the snapshot -----------------------------------------------------------------
const idMap = new Map(chosen.map((p, i) => [p.id, `demo_p${i + 1}`]));
const commentIds = new Map(rawComments.map((c, i) => [c.id, `demo_c${i + 1}`]));
const snapshot = {
  exportedAt: new Date().toISOString(),
  page: { id: 'demo', name: 'Demo Shop', language: 'banglish' },
  posts: chosen.map((p, i) => ({
    id: idMap.get(p.id), message: finalText(stage1.posts[i]), photo_url: fresh.get(p.id)?.full_picture ?? p.photo_url,
    created_time: p.created_time, reactions: p.reactions, comments_count: p.comments_count, shares: p.shares,
    engagement_score: p.engagement_score, is_boosted: p.is_boosted,
  })),
  comments: rawComments.map((c, i) => ({
    id: commentIds.get(c.id), post_id: idMap.get(c.postId), message: finalText(stage1.comments[i]), created_time: c.created_time,
    parent_id: commentIds.get(c.parent_id) ?? null, is_page: c.is_page, answered: c.answered,
    intent: null, size: null, color: null,
  })),
  post_tags: [],
};
fs.writeFileSync(new URL('../demo/snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 1));
if (process.env.EXPORT_NAMES_OUT) fs.writeFileSync(process.env.EXPORT_NAMES_OUT, JSON.stringify([...nameToAlias.keys()])); // kept out of the repo
const own = snapshot.comments.filter((c) => c.is_page).length;
console.log(`posts ${snapshot.posts.length}, comments ${snapshot.comments.length} (${own} by the page, ${snapshot.comments.filter((c) => c.answered).length} customer comments answered)`);
console.log(`${aliases.size} tagged people/pages and ${untagged} plain-text names replaced with aliases`);
