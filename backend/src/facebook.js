import 'dotenv/config';

const GRAPH = `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || 'v26.0'}`;

// `path` is a Graph path, or a full URL (e.g. a paging.next link, which already carries its params).
export async function graph(path, params = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    const body = await res.json();
    if (res.ok && !body.error) return body;
    const transient = res.status >= 500 || [1, 2, 4, 17, 32, 613].includes(body.error?.code);
    if (transient && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const err = new Error(body.error?.message || `Graph API ${res.status}`);
    err.status = 400;
    throw err;
  }
}

// Yields each page of `data` by following paging.next until it runs out.
export async function* paginate(path, params) {
  let body = await graph(path, params);
  while (true) {
    yield body.data;
    if (!body.paging?.next) return;
    body = await graph(body.paging.next);
  }
}

// Swap a short-lived user token (from the JS SDK) for a long-lived one (~60 days).
export async function exchangeLongLivedToken(shortToken) {
  const { FB_APP_ID, FB_APP_SECRET } = process.env;
  if (!FB_APP_ID || !FB_APP_SECRET) throw new Error('FB_APP_ID / FB_APP_SECRET are not set.');
  const { access_token } = await graph('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: FB_APP_ID,
    client_secret: FB_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  return access_token;
}

// Pages the user manages. Page tokens from a long-lived user token don't expire.
export async function listUserPages(userToken) {
  const pages = [];
  let after;
  do {
    const body = await graph('/me/accounts', {
      access_token: userToken,
      fields: 'id,name,access_token',
      limit: '100',
      ...(after && { after }),
    });
    pages.push(...body.data);
    after = body.paging?.next ? body.paging.cursors.after : undefined;
  } while (after);
  return pages;
}
