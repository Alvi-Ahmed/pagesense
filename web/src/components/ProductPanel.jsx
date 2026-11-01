import { useEffect, useState } from 'react'
import { get, patch, post } from '../api'
import { editLocal, localEdits, localUpdates, mergeLocal, storeLocalUpdates } from '../catalogLocal'
import { ErrorState, Skeleton } from './ui'
import { StatusChip } from './StatusChip'

const input = 'min-h-11 rounded-btn border border-line px-3 text-[15px] font-normal text-ink'
const asText = (list) => (list ?? []).join(', ')

function Field({ label, children }) {
  return <label className="flex flex-col gap-1 text-xs font-semibold text-muted">{label}{children}</label>
}

function Suggestion({ s }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(s.caption); setCopied(true) } catch { /* the text is selectable */ } }
  return (
    <li className="flex flex-col gap-2 rounded-card border border-line bg-white p-3">
      <div className="flex gap-3">
        {s.photo_url && <img src={s.photo_url} alt="" loading="lazy" className="size-14 shrink-0 rounded-btn bg-track object-cover" />}
        <details className="min-w-0 flex-1 text-xs text-muted">
          <summary className="min-h-8 cursor-pointer font-semibold">See the original caption</summary>
          <p className="whitespace-pre-wrap">{s.original_caption || '(no caption)'}</p>
        </details>
      </div>
      {s.caption ? (
        <>
          <textarea readOnly value={s.caption} rows={Math.min(8, s.caption.split('\n').length + 1)} aria-label="Suggested caption"
            className="rounded-btn border border-line bg-bg px-3 py-2 text-sm leading-relaxed" />
          {s.similar && <p className="text-xs text-muted">Points customers to: <strong>{s.similar.name}</strong></p>}
          <div className="grid grid-cols-2 gap-2">
            <button onClick={copy} className="min-h-11 rounded-btn bg-accent px-3 text-sm font-bold text-white">{copied ? 'Copied!' : 'Copy caption'}</button>
            <button disabled className="min-h-11 rounded-btn border border-line bg-track px-3 text-xs font-semibold text-muted opacity-70">Update on Facebook</button>
          </div>
        </>
      ) : <p role="alert" className="text-xs text-warn">{(s.problems ?? ['No suggestion.']).join(' ')}</p>}
    </li>
  )
}

// Everything about one product: edit it, sell it out or restock it, merge a duplicate into it, and review the caption
// updates for its posts. The demo keeps every change in this tab.
export function ProductPanel({ session, summary, others, onClose, onChanged }) {
  const demo = session.demo
  const pageId = session.page.id
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [form, setForm] = useState(null)
  const [mergeId, setMergeId] = useState('')
  const [updates, setUpdates] = useState({ sold_out: null, restock: null })
  const [caps, setCaps] = useState({ offer: false, stock: false })
  const [wasSoldOut, setWasSoldOut] = useState(false) // restocked in this session: offer the back-in-stock updates

  const view = detail && { ...detail, ...(demo ? localEdits(detail.id) : {}) }
  const startForm = (d) => setForm({ name: d.name, type: d.type ?? '', price: d.price ?? '', sizes: asText(d.sizes), colors: asText(d.colors), offer: d.offer ?? '', stock: d.stock ?? '' })

  useEffect(() => {
    let cancelled = false
    get(`/pages/${pageId}/catalog/${summary.id}`)
      .then(async (d) => {
        if (cancelled) return
        const merged = demo ? { ...d, ...localEdits(d.id) } : d
        setDetail(d); startForm(merged)
        const list = await get(`/pages/${pageId}/catalog`)
        if (!cancelled) setCaps(list.capabilities ?? caps)
        const saved = {}
        for (const kind of ['sold_out', 'restock']) {
          saved[kind] = demo ? localUpdates(d.id, kind) : (await get(`/pages/${pageId}/catalog/${d.id}/updates?kind=${kind}`)).suggestions
        }
        if (!cancelled) setUpdates({ sold_out: saved.sold_out?.suggestions ?? saved.sold_out, restock: saved.restock?.suggestions ?? saved.restock })
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opened product
  }, [pageId, summary.id])

  const guarded = async (name, fn) => {
    setBusy(name); setError(null)
    try { await fn() } catch (e) { setError(e.message) }
    setBusy(null)
  }
  const token = { accessToken: session.token }

  const save = () => guarded('save', async () => {
    const fields = { name: form.name, type: form.type, price: form.price === '' ? null : form.price, sizes: form.sizes, colors: form.colors, ...(caps.offer && { offer: form.offer }), ...(caps.stock && { stock: form.stock === '' ? null : form.stock }) }
    if (demo) {
      const num = fields.price === null ? null : Number(String(fields.price).replace(/[,\s৳]|tk\.?|taka/gi, ''))
      if (num !== null && (!Number.isFinite(num) || num < 0)) throw new Error('The price must be a number, for example 950.')
      if (!String(fields.name).trim()) throw new Error('A product needs a name.')
      const list = (t) => String(t).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean)
      editLocal(detail.id, { name: String(fields.name).trim(), type: String(fields.type).toLowerCase(), price: num, sizes: list(fields.sizes), colors: list(fields.colors).map((c) => c.toLowerCase()) })
    } else {
      const d = await patch(`/pages/${pageId}/catalog/${detail.id}`, { ...fields, ...token })
      setDetail((x) => ({ ...x, ...d }))
    }
    onChanged()
  })

  // Suggestions for the newest posts (or the next ones). Real pages save them on the server; the demo keeps them here.
  const writeUpdates = (kind, postIds) => guarded(`updates-${kind}`, async () => {
    const r = await post(`/pages/${pageId}/catalog/${detail.id}/updates`, { kind, ...(postIds && { postIds }), ...token })
    const merged = postIds ? [...(updates[kind] ?? []), ...r.suggestions] : r.suggestions
    setUpdates((u) => ({ ...u, [kind]: merged }))
    if (demo) storeLocalUpdates(detail.id, kind, merged)
    setDetail((d) => ({ ...d, _more: { ...d._more, [kind]: r.more_posts } }))
  })

  const setStatus = (status) => guarded('status', async () => {
    if (status !== 'sold_out' && view.status === 'sold_out') setWasSoldOut(true)
    if (demo) editLocal(detail.id, { status })
    else setDetail(await post(`/pages/${pageId}/catalog/${detail.id}/status`, { status, ...token }))
    setDetail((d) => ({ ...d, status }))
    onChanged()
    if (status === 'sold_out') await writeUpdatesInline('sold_out')
  })
  async function writeUpdatesInline(kind) {
    const r = await post(`/pages/${pageId}/catalog/${detail.id}/updates`, { kind, ...token })
    setUpdates((u) => ({ ...u, [kind]: r.suggestions }))
    if (demo) storeLocalUpdates(detail.id, kind, r.suggestions)
    setDetail((d) => ({ ...d, _more: { ...d._more, [kind]: r.more_posts } }))
  }

  const merge = () => guarded('merge', async () => {
    if (!mergeId) return
    if (demo) mergeLocal(detail.id, mergeId)
    else await post(`/pages/${pageId}/catalog/merge`, { keepId: detail.id, mergeId, ...token })
    onChanged(); onClose()
  })

  if (error && !detail) return <Overlay onClose={onClose}><ErrorState message={error} /></Overlay>
  if (!detail || !form) return <Overlay onClose={onClose}><Skeleton className="h-40" /><Skeleton className="h-64" /></Overlay>

  const status = view.status
  const soldOut = status === 'sold_out'
  const posts = detail.linked_posts
  const kind = soldOut ? 'sold_out' : 'restock'
  const shown = updates[kind]
  const covered = new Set((shown ?? []).map((s) => s.post_id))
  const next = posts.filter((p) => !covered.has(p.id)).slice(0, 5)
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  return (
    <Overlay onClose={onClose} title={view.name}>
      <div className="flex items-center gap-3">
        {detail.thumbnail_url && <img src={detail.thumbnail_url} alt="" className="size-20 shrink-0 rounded-card bg-track object-cover" />}
        <div className="flex min-w-0 flex-col gap-1.5">
          <StatusChip status={status} />
          <p className="text-xs text-muted">{detail.posts} linked {detail.posts === 1 ? 'post' : 'posts'} · {detail.source === 'uploaded' ? 'uploaded by you' : 'found in your posts'}</p>
        </div>
      </div>

      {error && <ErrorState message={error} />}

      <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
        <h2 className="text-[15px] font-bold">Details</h2>
        <Field label="Name"><input value={form.name} onChange={set('name')} maxLength={120} className={input} /></Field>
        <Field label="Price (Tk)"><input value={form.price} onChange={set('price')} inputMode="decimal" placeholder="not set" className={`${input} ${form.price === '' ? 'border-amber-line bg-amber-soft' : ''}`} /></Field>
        <Field label="Sizes"><input value={form.sizes} onChange={set('sizes')} placeholder="for example 38, 39, 40" className={input} /></Field>
        <Field label="Colors"><input value={form.colors} onChange={set('colors')} className={input} /></Field>
        <Field label="Type"><input value={form.type} onChange={set('type')} maxLength={40} className={input} /></Field>
        {caps.offer && <Field label="Offer"><input value={form.offer} onChange={set('offer')} maxLength={100} className={input} /></Field>}
        {caps.stock && <Field label="Stock (how many)"><input value={form.stock} onChange={set('stock')} inputMode="numeric" className={input} /></Field>}
        <button onClick={save} disabled={busy !== null} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
          {busy === 'save' ? 'Saving…' : 'Save details'}
        </button>
        {demo && <p className="text-xs text-muted">Demo mode: changes stay in this browser tab.</p>}
      </section>

      <section className="flex flex-col gap-2.5">
        {soldOut
          ? <button onClick={() => setStatus('in_stock')} disabled={busy !== null} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">Restock: it is back</button>
          : <button onClick={() => setStatus('sold_out')} disabled={busy !== null} className="min-h-12 rounded-btn border border-warn px-5 text-[15px] font-bold text-warn disabled:opacity-50">Mark as sold out</button>}
        {!soldOut && status === 'in_stock' && <button onClick={() => setStatus('pre_order')} disabled={busy !== null} className="min-h-11 text-sm font-semibold text-info">Switch to pre-order</button>}
        {!soldOut && status === 'pre_order' && <button onClick={() => setStatus('in_stock')} disabled={busy !== null} className="min-h-11 text-sm font-semibold text-info">Switch to in stock</button>}
        {busy === 'status' && <p role="status" className="text-sm text-muted">Writing caption updates for its posts. This takes a little while.</p>}
      </section>

      {(soldOut || shown || wasSoldOut) && (
        <section className="flex flex-col gap-3" aria-label={soldOut ? 'Sold-out updates' : 'Back-in-stock updates'}>
          <h2 className="text-[17px] font-bold">{soldOut ? 'Posts to update' : 'Back-in-stock updates'}</h2>
          <p className="text-sm text-muted">
            {soldOut
              ? `${posts.length} of your posts still show this product. Review each suggestion and copy it. Editing the post on Facebook from here is coming soon.`
              : 'The product is back. Write captions that say so for its posts.'}
          </p>
          {busy?.startsWith('updates') || busy === 'status' ? <Skeleton className="h-40" /> : null}
          {shown?.length > 0 && <ul className="flex flex-col gap-3">{shown.map((s) => <Suggestion key={s.post_id} s={s} />)}</ul>}
          {shown && shown.length === 0 && <p className="text-sm text-muted">No suggestions yet.</p>}
          {(!shown || shown.length === 0) && !busy && (
            <button onClick={() => writeUpdates(kind)} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">
              {soldOut ? 'Write updates for the newest posts' : 'Write "back in stock" updates'}
            </button>
          )}
          {shown?.length > 0 && next.length > 0 && !busy && (
            <button onClick={() => writeUpdates(kind, next.map((p) => p.id))} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">
              Write updates for {next.length} more {next.length === 1 ? 'post' : 'posts'}
            </button>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-[17px] font-bold">Linked posts ({posts.length})</h2>
        <ul className="flex flex-col gap-2">
          {posts.slice(0, 8).map((p) => (
            <li key={p.id} className="flex gap-3 rounded-card border border-line bg-white p-2.5">
              {p.photo_url && <img src={p.photo_url} alt="" loading="lazy" className="size-14 shrink-0 rounded-btn bg-track object-cover" />}
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm">{p.caption || 'No caption'}</p>
                <p className="text-xs text-muted">{Math.round(p.engagement_score)} engagement</p>
              </div>
            </li>
          ))}
        </ul>
        {posts.length > 8 && <p className="text-xs text-muted">and {posts.length - 8} more.</p>}
      </section>

      {others.length > 0 && (
        <section className="flex flex-col gap-2.5 rounded-card border border-line bg-white p-4">
          <h2 className="text-[15px] font-bold">Same product twice?</h2>
          <p className="text-sm text-muted">Pick the duplicate. Its posts and details move into this product and the duplicate is removed.</p>
          <select value={mergeId} onChange={(e) => setMergeId(e.target.value)} aria-label="Duplicate to merge" className={input}>
            <option value="">Choose a product…</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.posts} posts)</option>)}
          </select>
          <button onClick={merge} disabled={!mergeId || busy !== null} className="min-h-12 rounded-btn border border-line px-5 text-[15px] font-bold disabled:opacity-50">Merge into this product</button>
        </section>
      )}
    </Overlay>
  )
}

function Overlay({ children, onClose, title }) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title ?? 'Product'} className="fixed inset-0 z-30 overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-svh max-w-[430px] flex-col gap-4 px-5 pt-5 pb-16">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="flex min-h-11 items-center rounded-btn px-2 text-sm font-semibold text-info">← Back to catalog</button>
        </div>
        {title && <h1 className="text-[22px] font-bold">{title}</h1>}
        {children}
      </div>
    </div>
  )
}

