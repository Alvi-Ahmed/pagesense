import 'dotenv/config';

const GRAPH = `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || 'v26.0'}`;

// `path` is a Graph path, or a full URL (e.g. a paging.next link, which already carries its params).
export async function graph(path, params = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }); // never hang on a stalled call
    const body = await res.json();
    if (res.ok && !body.error) return body;
    const transient = res.status >= 500 || [1, 2, 4, 17, 32, 613].includes(body.error?.code);
    if (transient && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const err = new Error(body.error?.message || `Graph API ${res.status}`);
    err.status = 400;
    err.fb = body.error;
    if (body.error?.code === 190) { // the user's login token is expired or no longer valid
      err.status = 401;
      err.code = 'session_expired';
      err.message = 'Your Facebook login has expired. Please log in again.';
    }
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

// The page's Messenger order link: https://m.me/<username>, or the page id when the page has no username.
export async function messengerLink(pageId, accessToken) {
  const page = await graph(`/${pageId}`, { fields: 'username', access_token: accessToken });
  return `https://m.me/${page.username || pageId}`;
}

// Multi-photo post, per the Graph API docs (developers.facebook.com/docs/graph-api/reference/page/photos): every photo is
// uploaded UNPUBLISHED (published=false; Facebook keeps it about 24 hours), then ONE feed post attaches them all with
// attached_media[i]={"media_fbid":"<id>"}. Photos are JPEG buffers, at most 10 MB each. Returns the post id.
// NOT called from any route yet: publishing is item 11, and a call here posts to the live page.
export async function publishPhotoPost(pageId, accessToken, { message, photos }) {
  const post = async (path, body) => {
    const res = await fetch(`${GRAPH}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(60_000) });
    const json = await res.json();
    if (!res.ok || json.error) throw Object.assign(new Error(json.error?.message || `Graph API ${res.status}`), { status: 400, fb: json.error });
    return json;
  };
  if (!photos?.length || photos.length > 10) throw Object.assign(new Error('A post needs 1 to 10 photos.'), { status: 400 });
  const ids = [];
  for (const [i, jpeg] of photos.entries()) {
    const form = new FormData();
    form.set('source', new Blob([jpeg], { type: 'image/jpeg' }), `photo-${i + 1}.jpg`);
    form.set('published', 'false');
    form.set('access_token', accessToken);
    ids.push((await post(`/${pageId}/photos`, form)).id);
  }
  const form = new FormData();
  form.set('message', message);
  ids.forEach((id, i) => form.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  form.set('access_token', accessToken);
  return (await post(`/${pageId}/feed`, form)).id;
}
