import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { get } from '../api'
import { applyLocal, summarize } from '../catalogLocal'
import { EmptyState, ErrorState, ScreenHeader, Skeleton } from '../components/ui'
import { ProductPanel } from '../components/ProductPanel'
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
          {p.price != null
            ? <p className="text-sm font-semibold text-accent-dark">Tk {p.price}</p>
            : <p className="text-xs font-semibold text-amber-ink">No price yet</p>}
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
  const [open, setOpen] = useState(null)

  useEffect(() => {
    let cancelled = false
    get(`/pages/${pageId}/catalog`)
      .then((r) => { if (!cancelled) { setList(r); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, analysis?.finished_at, attempt, changes])

  // the whole catalog is loaded once: searching and filtering are instant, and the demo's local edits sit on top
  const products = useMemo(() => (list ? (session.demo ? applyLocal(list.products) : list.products) : []), [list, session.demo, changes]) // eslint-disable-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarize(products), [products])
  const visible = useMemo(() => {
    const needle = query.toLowerCase().trim()
    return products.filter((p) => {
      if (filter === 'no_price' ? p.price != null : filter !== 'all' && p.status !== filter) return false
      return !needle || [p.name, p.type, p.phrase, ...p.colors, ...p.sizes].join(' ').toLowerCase().includes(needle)
    })
  }, [products, query, filter])

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
            <ul className="flex flex-col gap-2">{visible.slice(0, shown).map((p) => <Row key={p.id} p={p} onOpen={setOpen} />)}</ul>
            {visible.length > shown && (
              <button onClick={() => setShown((n) => n + PAGE)} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">Show more</button>
            )}
          </>
        )}

      {open && (
        <ProductPanel key={open.id} session={session} summary={open} others={others}
          onClose={() => setOpen(null)} onChanged={() => setChanges((n) => n + 1)} />
      )}
    </>
  )
}
