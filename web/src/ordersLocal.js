// The demo is read-only on the server, so a visitor's order changes (status, edited details, "mark as order") live in
// their own tab and are laid over the list the server sends.
const KEY = 'pagesense.demoOrders'
const load = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || {} } catch { return {} }
}
const save = (state) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(state)) } catch { /* storage unavailable */ }
}

export function changeLocal(id, fields) {
  const s = load()
  s[id] = { ...s[id], ...fields }
  save(s)
}

// Products that never need a size; the same list the server uses.
const NO_SIZE = /bag|backpack|wallet|purse|clutch|pouch|earring|necklace|bangle|bracelet|ring|jewel|watch|scarf|belt|sunglass|mask|dupatta|umbrella|cap\b|hat\b|wax|paper/i

export const missingFor = ({ size, quantity, phone, address }, type) => [
  !size && !(type && NO_SIZE.test(type)) && 'size', quantity == null && 'quantity', !phone && 'phone', !address && 'address',
].filter(Boolean)

export function applyLocal(orders) {
  const s = load()
  return orders.map((o) => {
    const merged = { ...o, ...(s[o.id] ?? {}) }
    return { ...merged, missing: missingFor(merged, merged.product?.type) }
  })
}

export const countOrders = (orders) => ({
  to_review: orders.filter((o) => o.status === 'to_review' && o.kind === 'order').length,
  leads: orders.filter((o) => o.status === 'to_review' && o.kind === 'lead').length,
  confirmed: orders.filter((o) => o.status === 'confirmed').length,
  delivered: orders.filter((o) => o.status === 'delivered').length,
  cancelled: orders.filter((o) => o.status === 'cancelled').length,
})

const cell = (v) => {
  let t = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}` // a spreadsheet must not run a customer's text as a formula
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

// The same CSV the server makes for a real page, built here for the demo's local state.
export function ordersCsv(orders) {
  const header = ['product', 'size', 'color', 'quantity', 'comment_link', 'status', 'date', 'phone', 'address']
  const rows = orders.map((o) => [o.product?.name ?? o.post_name, o.size, o.color, o.quantity, o.comment_url, o.status, String(o.commented_at ?? '').slice(0, 10), o.phone, o.address])
  return `${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`
}
