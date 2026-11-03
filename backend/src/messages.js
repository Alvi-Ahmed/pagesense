import { db } from './db.js';
import { graph } from './facebook.js';

// Customers order in Messenger, not in comments. This reads a page's Messenger conversations through the Graph API
// (Page access token, needs the pages_messaging permission and a login that granted it). Nothing is sent: read only.
const CONVERSATIONS = 150; // newest conversations looked at per run
const MESSAGES = 30; // newest messages kept per conversation

async function pageToken(pageId) {
  const { data } = await db.from('pages').select('access_token').eq('id', pageId).maybeSingle();
  if (!data?.access_token) throw Object.assign(new Error('This page is not connected to Facebook.'), { status: 400 });
  return data.access_token;
}

// -> [{ id, updated_time, messages: [{ from: 'customer' | 'page', text, at }] }], oldest message first. Chats without any
// customer text are left out. A missing permission is reported in plain words.
export async function fetchConversations(pageId) {
  const token = await pageToken(pageId);
  const out = [];
  let url = `/${pageId}/conversations`;
  let params = {
    platform: 'messenger', limit: '25', access_token: token,
    fields: `id,updated_time,messages.limit(${MESSAGES}){message,from,created_time}`,
  };
  try {
    while (url && out.length < CONVERSATIONS) {
      const page = await graph(url, params);
      for (const c of page.data ?? []) {
        const messages = (c.messages?.data ?? []).filter((m) => m.message?.trim())
          .map((m) => ({ from: m.from?.id === pageId ? 'page' : 'customer', text: m.message.trim(), at: m.created_time }))
          .sort((a, b) => a.at.localeCompare(b.at));
        if (messages.some((m) => m.from === 'customer')) out.push({ id: c.id, updated_time: c.updated_time, messages });
      }
      url = page.paging?.next ?? null;
      params = {};
    }
  } catch (e) {
    if (e.fb?.code === 200 || e.fb?.code === 10 || /permission|pages_messaging/i.test(e.message)) {
      throw Object.assign(new Error('PageSense cannot read your Messenger chats yet. Log in again and allow access to messages.'), { status: 403, code: 'messaging_permission' });
    }
    throw e;
  }
  return out.slice(0, CONVERSATIONS);
}
