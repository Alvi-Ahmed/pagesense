// Test 2: Can we read posts, photos, reactions, comments and shares from the page?
// Run: npm run test:graph
import 'dotenv/config';

const { FB_PAGE_ID, FB_PAGE_TOKEN, FB_GRAPH_VERSION = 'v26.0' } = process.env;
if (!FB_PAGE_ID || !FB_PAGE_TOKEN) {
  console.error('Set FB_PAGE_ID and FB_PAGE_TOKEN in .env (see README for how to get them).');
  process.exit(1);
}

const fields = [
  'id', 'message', 'created_time', 'full_picture', 'permalink_url', 'shares',
  'reactions.summary(total_count).limit(0)',
  'comments.summary(true).limit(25){message,created_time}'
].join(',');

const url = `https://graph.facebook.com/${FB_GRAPH_VERSION}/${FB_PAGE_ID}/posts?fields=${encodeURIComponent(fields)}&limit=25&access_token=${FB_PAGE_TOKEN}`;

const res = await fetch(url);
const data = await res.json();
if (data.error) {
  console.error('Graph API error:', data.error);
  process.exit(1);
}

const posts = data.data || [];
console.table(posts.map(p => ({
  date: p.created_time?.slice(0, 10),
  text: (p.message || '').slice(0, 40),
  photo: p.full_picture ? 'yes' : 'no',
  reactions: p.reactions?.summary?.total_count ?? 0,
  comments: p.comments?.summary?.total_count ?? 0,
  commentTextRead: p.comments?.data?.length ?? 0,
  shares: p.shares?.count ?? 0,
})));

const withComments = posts.find(p => p.comments?.data?.length);
console.log('\nPosts read:', posts.length, '| more pages available:', Boolean(data.paging?.next));
console.log('Sample comments:', withComments ? withComments.comments.data.slice(0, 5).map(c => c.message) : 'NONE: comment text not returned (check pages_read_user_content)');
