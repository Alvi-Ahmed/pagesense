import { useEffect, useMemo, useState } from 'react'
import { useLocation, useOutletContext } from 'react-router-dom'
import { API_URL, get, patch } from '../api'
import { applyLocal, summarize } from '../catalogLocal'
import { applyStock, localLayout, localLines } from '../stockLocal'
import { EmptyState, ErrorState, ScreenHeader, Skeleton } from '../components/ui'
import { ProductPanel } from '../components/ProductPanel'
import { StockImport } from '../components/StockImport'
import { StatusChip } from '../components/StatusChip'

const FILTERS = [['all', 'All'], ['in_stock', 'In stock'], ['pre_order', 'Pre-order'], ['sold_out', 'Sold out'], ['no_price', 'No price']]
const PAGE = 60

function Row({ p, onOpen }) {
  return (
    <li>
      <button onClick={() => onOpen(p)} className="flex w-full items-center gap-3 rounded-card border border-line bg-white p-2.5 text-left">
        {p.thumbnail_url
          ? <img src={p.thumbnail_url} alt="" loading="lazy" className="size-16 shrink-0 rounded-btn bg-track object-cover" />
          : <div className="size-16 shrink-0 rounded-btn bg-track" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <span className="line-clamp-2 text-[15px] font-bold">{p.name}</span>
            <StatusChip status={p.status} />
          </div>
          <p className="text-xs text-muted"><span className="capitalize">{p.type ?? 'product'}</span> · {p.posts} {p.posts === 1 ? 'post' : 'posts'}</p>
          <div className="flex items-center justify-between gap-2">
            {p.price != null
              ? <p className="text-sm font-semibold text-accent-dark">Tk {p.price}</p>
              : <p className="text-xs font-semibold text-amber-ink">No price yet</p>}
            {p.stock != null && <p className={`text-xs font-bold ${p.stock === 0 ? 'text-warn' : p.stock <= (p.low ?? 3) ? 'text-amber-ink' : 'text-muted'}`}>{p.stock === 0 ? 'Out of stock' : `${p.stock} in stock`}</p>}
          </div>
        </div>
      </button>
    </li>
  )
}

export function Catalog() {
  const { session, analysis } = useOutletContext()
  const pageId = session.page.id
  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [changes, setChanges] = useState(0) // bumps when the demo visitor changes something in this tab
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [shown, setShown] = useState(PAGE)
  const [openId, setOpenId] = useState(useLocation().state?.open ?? null) // Home's alerts open a product directly
  const [importing, setImporting] = useState(false)
  const [threshold, setThreshold] = useState(3)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let cancelled = false
    get(`/pages/${pageId}/catalog`)
      .then((r) => { if (!cancelled) { setList(r); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, analysis?.finished_at, attempt, changes])

  // the whole catalog is loaded once: searching and filtering are instant, and the demo's local edits sit on top
  const products = useMemo(() => (list ? (session.demo ? applyStock(applyLocal(list.products)) : list.products).map((p) => ({ ...p, low: threshold })) : []), [list, session.demo, changes, threshold]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = products.find((p) => p.id === openId) ?? null
  const summary = useMemo(() => summarize(products), [products])
  const visible = useMemo(() => {
    const needle = query.toLowerCase().trim()
    return products.filter((p) => {
      if (filter === 'no_price' ? p.price != null : filter !== 'all' && p.status !== filter) return false
      return !needle || [p.name, p.type, p.phrase, ...p.colors, ...p.sizes].join(' ').toLowerCase().includes(needle)
    })
  }, [products, query, filter])

  useEffect(() => {
    if (session.demo) return
    get(`/pages/${pageId}/stock/alerts`).then((a) => setThreshold(a.threshold)).catch(() => {})
  }, [pageId, session.demo, session.token])

  const saveThreshold = async (value) => {
    const n = Number(value)
    setThreshold(n)
    if (session.demo || !Number.isInteger(n) || n < 0) return
    try { await patch(`/pages/${pageId}/settings`, { low_stock_threshold: n, accessToken: session.token }) } catch (e) { setMessage(e.message) }
  }

  // "Download as Excel": the current stock in the owner's own columns
  const download = async () => {
    setMessage(null)
    try {
      let blob
      if (session.demo) {
        const res = await fetch(`${API_URL}/pages/${pageId}/stock/xlsx`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: localLines(products), layout: localLayout() }) })
        if (!res.ok) throw new Error('Could not make the Excel file.')
        blob = await res.blob()
      } else {
        const res = await fetch(`${API_URL}/pages/${pageId}/stock/export`, { headers: { 'x-access-token': session.token } })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (HTTP ${res.status})`)
        blob = await res.blob()
      }
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `stock-${new Date().toISOString().slice(0, 10)}.xlsx`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e) { setMessage(e.message) }
  }

  const header = <ScreenHeader title="Catalog" subtitle="What you sell, found in your posts" />
  if (error && !list) return <>{header}<ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} /></>
  if (!list) return <>{header}<Skeleton className="h-12" /><Skeleton className="h-24" /><Skeleton className="h-24" /></>
  if (!products.length) {
    return (
      <>
        {header}
        <EmptyState title="Your catalog will appear when analysis finishes">We build it from your posts, and you can edit anything. New products you upload are added here too.</EmptyState>
      </>
    )
  }

  const others = open ? products.filter((p) => p.id !== open.id && p.type === open.type).slice(0, 80) : []
  return (
    <>
      {header}
      {summary.missing_price > 0 && (
        <button onClick={() => setFilter('no_price')} className="rounded-card bg-amber-soft px-4 py-3 text-left text-sm text-amber-ink">
          <strong>{summary.missing_price} {summary.missing_price === 1 ? 'product has' : 'products have'} no price.</strong> Add a price once and every new post uses it.
          <span className="ml-1 font-bold underline">Show them</span>
        </button>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => setImporting(true)} className="min-h-12 rounded-btn bg-accent px-3 text-sm font-bold text-white">Import stock (Excel)</button>
        <button onClick={download} className="min-h-12 rounded-btn border border-line bg-white px-3 text-sm font-bold">Download as Excel</button>
      </div>
      {!session.demo && (
        <label className="flex items-center gap-2 text-xs text-muted">Say “few left” when stock is at or below
          <input type="number" min="0" value={threshold} onChange={(e) => saveThreshold(e.target.value)} className="min-h-9 w-16 rounded-btn border border-line bg-white px-2 text-center text-sm text-ink" />
        </label>
      )}
      {message && <ErrorState message={message} />}

      <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE) }} placeholder="Search products" aria-label="Search products"
        className="min-h-12 rounded-btn border border-line bg-white px-4 text-[15px]" />
      <div role="tablist" aria-label="Filter" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {FILTERS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={filter === id} onClick={() => { setFilter(id); setShown(PAGE) }}
            className={`min-h-10 shrink-0 rounded-full px-3.5 text-sm font-semibold ${filter === id ? 'bg-accent text-white' : 'border border-line bg-white'}`}>
            {label}{id !== 'all' && id !== 'no_price' && ` ${summary[id]}`}
          </button>
        ))}
      </div>

      {visible.length === 0
        ? <EmptyState title="Nothing matches">Try a different search or filter.</EmptyState>
        : (
          <>
            <p className="text-xs text-muted">{visible.length} {visible.length === 1 ? 'product' : 'products'}</p>
            <ul className="flex flex-col gap-2">{visible.slice(0, shown).map((p) => <Row key={p.id} p={p} onOpen={(x) => setOpenId(x.id)} />)}</ul>
            {visible.length > shown && (
              <button onClick={() => setShown((n) => n + PAGE)} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">Show more</button>
            )}
          </>
        )}

      {open && (
        <ProductPanel key={open.id} session={session} summary={open} others={others}
          onClose={() => setOpenId(null)} onChanged={() => setChanges((n) => n + 1)} />
      )}
      {importing && <StockImport session={session} onClose={() => setImporting(false)} onDone={() => setChanges((n) => n + 1)} />}
    </>
  )
}
