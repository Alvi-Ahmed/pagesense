import { addLocalProduct, editLocal } from './catalogLocal'

// The demo's stock lives in the visitor's tab: imports and edits are laid over the server's catalog and never saved.
const KEY = 'pagesense.demoStock'
const load = () => {
  try { return { variants: {}, layout: null, ...JSON.parse(sessionStorage.getItem(KEY)) } } catch { return { variants: {}, layout: null } }
}
const save = (state) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage unavailable */ }
}

export const localVariants = (id) => load().variants[id] ?? null
export const localTotal = (variants) => variants.reduce((n, v) => n + v.quantity, 0)

export function setLocalVariants(id, variants) {
  const s = load()
  s.variants[id] = variants
  save(s)
  const total = localTotal(variants)
  if (variants.length) editLocal(id, { stock: total, ...(total === 0 && { status: 'sold_out' }) })
}

// What the owner confirmed in the import preview, applied here instead of on the server.
export function importLocal(groups, layout) {
  const s = load()
  const result = { updated: 0, created: 0, variants: 0, skipped: 0, sold_out: [], restocked: [] }
  for (const g of groups) {
    if (g.action === 'skip') { result.skipped++; continue }
    const incoming = g.variants.map((v) => ({ size: v.size, color: v.color, quantity: v.quantity, sku: v.sku ?? null }))
    let id = g.product_id
    if (g.action === 'create') {
      const prices = g.variants.map((v) => v.price).filter((p) => Number.isFinite(p) && p > 0)
      id = addLocalProduct({ name: g.name, price: prices[0] ?? null, sizes: [...new Set(incoming.map((v) => v.size).filter(Boolean))], colors: [...new Set(incoming.map((v) => v.color).filter(Boolean))] })
    }
    const merged = [...(s.variants[id] ?? [])]
    for (const v of incoming) {
      const i = merged.findIndex((m) => m.size === v.size && m.color === v.color)
      if (i >= 0) merged[i] = { ...merged[i], ...v }; else merged.push(v)
    }
    s.variants[id] = merged
    save({ ...s, layout })
    const total = localTotal(merged)
    editLocal(id, { stock: total, ...(total === 0 && { status: 'sold_out' }) })
    if (total === 0) result.sold_out.push(g.name)
    result[g.action === 'create' ? 'created' : 'updated']++
    result.variants += incoming.length
  }
  save({ ...s, layout })
  return result
}

export const localLayout = () => load().layout

// Rows for the Excel download in the demo.
export function localLines(products) {
  const s = load()
  return products.flatMap((p) => (s.variants[p.id] ?? []).map((v) => ({ name: p.name, size: v.size, color: v.color, quantity: v.quantity, price: p.price ?? '', sku: v.sku ?? '' })))
}

export const applyStock = (products) => {
  const s = load()
  return products.map((p) => (s.variants[p.id] ? { ...p, stock: localTotal(s.variants[p.id]) } : p))
}
