// Copy the photos of already-synced posts into our own storage (new syncs do this by themselves). Pages through the
// page's posts on Facebook for fresh picture links, so it also repairs posts whose saved link has expired.
// Run: npm run photos:archive [-- <pageId>]   (default: every connected page)
import { db } from '../src/db.js';
import { paginate } from '../src/facebook.js';
import { archiveRows } from '../src/photos.js';

const { data: pages } = await db.from('pages').select('id, name, access_token').neq('id', 'demo').not('access_token', 'is', null);
for (const page of (pages ?? []).filter((p) => !process.argv[2] || p.id === process.argv[2])) {
  let seen = 0, stored = 0;
  for await (const batch of paginate(`/${page.id}/posts`, { access_token: page.access_token, fields: 'id,full_picture', limit: '50' })) {
    const rows = await archiveRows(page.id, batch.filter((p) => p.full_picture).map((p) => ({ id: p.id, photo_url: p.full_picture })));
    for (const r of rows.filter((x) => x.photo_url.startsWith('storage://'))) {
      const { error } = await db.from('posts').update({ photo_url: r.photo_url }).eq('id', r.id).eq('page_id', page.id);
      if (!error) stored++;
    }
    seen += rows.length;
    if (seen % 500 < 50) console.log(`${page.name}: ${seen} photos seen, ${stored} stored`);
  }
  console.log(`${page.name}: done, ${seen} photos seen, ${stored} stored`);
}
