import 'dotenv/config';

const GRAPH = `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || 'v26.0'}`;

async function graph(path, params) {
  const res = await fetch(`${GRAPH}${path}?${new URLSearchParams(params)}`);
  const body = await res.json();
  if (!res.ok || body.error) {
    const err = new Error(body.error?.message || `Graph API ${res.status}`);
    err.status = 400;
    throw err;
  }
  return body;
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
