// The demo catalog is read-only on the server: a visitor's edits, status changes, merges and caption suggestions
// live in their own tab (sessionStorage) and are laid over the list the server sends.
const KEY = 'pagesense.demoCatalog'
const empty = () => ({ edits: {}, merges: {}, updates: {}, added: [] })

const load = () => {
  try { return { ...empty(), ...JSON.parse(sessionStorage.getItem(KEY)) } } catch { return empty() }
}
const save = (state) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage unavailable */ }
  return state
}

export const localEdits = (id) => load().edits[id] ?? {}
export const localUpdates = (id, kind) => load().updates[`${id}:${kind}`] ?? null

export function editLocal(id, fields) {
  const s = load()
  s.edits[id] = { ...s.edits[id], ...fields }
  return save(s)
}
export function mergeLocal(keepId, mergeId) {
  const s = load()
  s.merges[mergeId] = keepId
  return save(s)
}
// A product the demo visitor created by importing a stock sheet. It exists only in this tab.
export function addLocalProduct({ name, price, sizes, colors }) {
  const s = load()
  const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  s.added = [...(s.added ?? []), {
    id, name, type: null, phrase: null, price: price ?? null, sizes, colors, offer: null, stock: null, status: 'in_stock', source: 'uploaded',
    posts: 0, thumbnail_url: null, photo_ref: null, source_post_id: null, missing_price: price == null,
  }]
  save(s)
  return id
}

export function storeLocalUpdates(id, kind, payload) {
  const s = load()
  s.updates[`${id}:${kind}`] = payload
  return save(s)
}

// The server's list with this visitor's changes on top.
export function applyLocal(products) {
  const s = load()
  const byId = new Map([...products, ...(s.added ?? [])].map((p) => [p.id, { ...p, ...(s.edits[p.id] ?? {}) }]))
  for (const [from, to] of Object.entries(s.merges)) {
    const keep = byId.get(to)
    const gone = byId.get(from)
    if (!keep || !gone) continue
    keep.posts += gone.posts
    keep.price ??= gone.price
    keep.sizes = [...new Set([...keep.sizes, ...gone.sizes])]
    keep.colors = [...new Set([...keep.colors, ...gone.colors])]
    byId.delete(from)
  }
  return [...byId.values()].map((p) => ({ ...p, missing_price: p.price == null }))
}

export const summarize = (products) => ({
  total: products.length,
  missing_price: products.filter((p) => p.price == null).length,
  in_stock: products.filter((p) => p.status === 'in_stock').length,
  pre_order: products.filter((p) => p.status === 'pre_order').length,
  sold_out: products.filter((p) => p.status === 'sold_out').length,
})
