import { get } from './api'

// The demo page is read-only, so its drafts live in the visitor's tab (sessionStorage) and vanish with it.
const KEY = 'pagesense.demoDrafts'
const MAX = 10

const load = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || [] } catch { return [] }
}
const save = (drafts) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(drafts.slice(0, MAX))) } catch { /* storage unavailable */ }
}

export const demoDrafts = () => load()

export function saveDemoDraft(result) {
  const { caption, language, photo_url, source_post_id, ...details } = result
  const draft = {
    id: `local-${Date.now()}`, caption, language, photo_url, source_post_id,
    why: details, created_at: new Date().toISOString(),
  }
  save([draft, ...load()])
  return draft
}

export function updateDemoDraft(id, caption) {
  save(load().map((d) => (d.id === id ? { ...d, caption } : d)))
}

// Drafts for the connected page: from the server for a real page, from this tab for the demo.
export async function loadDrafts(session) {
  if (session.demo) return load()
  return (await get(`/pages/${session.page.id}/drafts`)).drafts
}

// A stored draft back into the shape the Create screen works with.
export function fromDraft(d) {
  const details = d.why || {}
  return {
    kind: details.kind || 'generate', caption: d.caption, language: d.language, photo_url: d.photo_url,
    source_post_id: d.source_post_id, why: details.why || [], changes: details.changes || [],
    original_caption: details.original_caption || null, product: details.product || null,
    placeholders: details.placeholders || [], draft_id: d.id,
  }
}
