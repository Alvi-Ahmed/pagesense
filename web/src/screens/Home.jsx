import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { get } from '../api'
import { loadDrafts } from '../drafts'
import { usePlaybook } from '../usePlaybook'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'

const INTENT_LABEL = {
  complaint: 'Complaint', order_intent: 'Wants to order', price_question: 'Asking the price',
  size_or_color_request: 'Size or color', stock_or_restock: 'In stock?', delivery_question: 'Delivery',
  product_question: 'Product question', negotiation: 'Discount',
}
const URGENT = new Set(['complaint', 'order_intent'])

// A tile is a door to the list it counts: to the Orders screen, or a filter on the replies list below.
function Tile({ value, label, color, to, onClick, active }) {
  const body = (
    <>
      <span className={`text-[26px] font-bold ${color}`}>{value}</span>
      <span className="text-xs leading-snug text-muted">{label}</span>
    </>
  )
  const cls = `flex flex-col gap-1 rounded-card border bg-white px-3 py-3.5 text-left text-ink no-underline ${active ? 'border-accent ring-2 ring-accent-pale' : 'border-line'}`
  return to ? <Link to={to} className={cls}>{body}</Link> : <button onClick={onClick} aria-pressed={active} className={cls}>{body}</button>
}

function PostToday({ playbook }) {
  const headline = playbook?.summary?.headline
  if (!headline) {
    return (
      <EmptyState title="Your first post idea is on its way">
        A suggestion for what to post today appears here when analysis finishes.
      </EmptyState>
    )
  }
  const action = playbook.summary.actions?.[0]
  return (
    <section className="flex flex-col gap-2 rounded-hero bg-accent px-5 py-5 text-white">
      <span className="text-xs font-semibold tracking-wide uppercase opacity-80">Post this today</span>
      {action && <p className="text-[20px] leading-snug font-bold">{action}</p>}
      <p className="text-sm opacity-90">{headline}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        <Link to="/create" state={{ hint: action || headline }}
          className="flex min-h-11 items-center rounded-btn bg-white px-4 text-sm font-bold text-accent-dark no-underline">
          Create this post
        </Link>
        <Link to="/playbook" className="flex min-h-11 items-center rounded-btn border border-white/60 px-4 text-sm font-bold text-white no-underline">
          See the playbook
        </Link>
      </div>
    </section>
  )
}

function Drafts({ session, analysis }) {
  const [drafts, setDrafts] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadDrafts(session).then((d) => { if (!cancelled) setDrafts(d) }).catch(() => { if (!cancelled) setDrafts([]) })
    return () => { cancelled = true }
  }, [session, analysis?.finished_at])
  if (!drafts?.length) return null
  return (
    <section className="flex flex-col gap-2.5">
      <Link to="/create" state={{ draftId: drafts[0].id }} className="flex flex-col gap-2 rounded-card border border-accent bg-accent-soft p-3.5 text-ink no-underline">
        <span className="text-xs font-bold tracking-wide text-accent-dark uppercase">Continue your draft</span>
        <div className="flex items-center gap-3">
          {drafts[0].photo_url && <img src={drafts[0].photo_url} alt="" loading="lazy" className="size-16 shrink-0 rounded-btn bg-track object-cover" />}
          <p className="line-clamp-3 min-w-0 flex-1 text-sm">{drafts[0].caption}</p>
        </div>
        <span className="text-sm font-bold text-accent-dark">Open it →</span>
      </Link>
      {drafts.length > 1 && <h2 className="text-[15px] font-bold">Other drafts</h2>}
      <ul className="flex flex-col gap-2">
        {drafts.slice(1, 4).map((d) => (
          <li key={d.id}>
            <Link to="/create" state={{ draftId: d.id }} className="flex items-center gap-3 rounded-card border border-line bg-white p-2.5 text-ink no-underline">
              {d.photo_url && <img src={d.photo_url} alt="" loading="lazy" className="size-14 shrink-0 rounded-btn bg-track object-cover" />}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm">{d.caption}</p>
                <p className="text-xs text-muted capitalize">{d.language}{session.demo ? ' · this tab only' : ''}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

// Products that sold out (stock 0) or are running low, with one tap to the next step.
function StockAlerts({ pageId, analysis }) {
  const [alerts, setAlerts] = useState(null)
  useEffect(() => {
    let cancelled = false
    get(`/pages/${pageId}/stock/alerts`).then((a) => { if (!cancelled) setAlerts(a) }).catch(() => {})
    return () => { cancelled = true }
  }, [pageId, analysis?.finished_at])
  if (!alerts?.ready || (!alerts.low.length && !alerts.sold_out.length)) return null
  return (
    <section className="flex flex-col gap-2.5" aria-label="Stock alerts">
      <h2 className="text-[17px] font-bold">Stock</h2>
      <ul className="flex flex-col gap-2">
        {alerts.sold_out.map((p) => (
          <li key={p.id}>
            <Link to="/catalog" state={{ open: p.id }} className="flex items-center justify-between gap-3 rounded-card border border-warn bg-warn-soft p-3 text-ink no-underline">
              <span className="text-sm"><strong>{p.name}</strong> is sold out. Update the posts that still sell it.</span>
              <span className="shrink-0 text-sm font-bold text-warn">Open →</span>
            </Link>
          </li>
        ))}
        {alerts.low.map((p) => (
          <li key={p.id}>
            <Link to="/create" state={{ productId: p.id, hint: `Only ${p.stock} left: tell customers it is almost gone` }} className="flex items-center justify-between gap-3 rounded-card border border-amber-line bg-amber-soft p-3 text-ink no-underline">
              <span className="text-sm"><strong>Only {p.stock} left</strong> of {p.name}. Write a “few left” post.</span>
              <span className="shrink-0 text-sm font-bold text-amber-ink">Write →</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Replies({ pageId, ready, total, intent, onClear }) {
  const [replies, setReplies] = useState(null)
  const [limit, setLimit] = useState(8)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    get(`/pages/${pageId}/replies?limit=${limit}${intent ? `&intent=${intent}` : ''}`)
      .then((r) => { if (!cancelled) { setReplies(r); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, ready, attempt, intent, limit])

  if (!ready) return <EmptyState title="Nothing to reply to yet">Comments that need an answer show up here once {total} comments are read.</EmptyState>
  if (error) return <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
  if (!replies) return <Skeleton className="h-32" />
  if (!replies.items.length) return <EmptyState title="Nothing to reply to">{intent ? `No ${INTENT_LABEL[intent].toLowerCase()} comments are waiting.` : 'No open questions or complaints in your comments.'}</EmptyState>
  return (
    <>
      {intent && (
        <p className="flex items-center gap-2 text-sm">
          Showing only <strong>{INTENT_LABEL[intent]}</strong>
          <button onClick={onClear} className="min-h-9 font-semibold text-info underline">Show all</button>
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {replies.items.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 rounded-card border border-line bg-white px-4 py-3">
            <div className="flex items-center gap-2 text-xs">
              <span className={`rounded-full px-2 py-0.5 font-semibold ${URGENT.has(c.intent) ? 'bg-warn-soft text-warn' : 'bg-info-soft text-info'}`}>
                {INTENT_LABEL[c.intent]}
              </span>
              {c.size && <span className="text-muted">size {c.size}</span>}
              {c.color && <span className="text-muted">{c.color}</span>}
            </div>
            <p className="text-sm">{c.message}</p>
            <p className="line-clamp-1 text-xs text-muted">On: {c.post_caption || 'a photo post'}</p>
            {c.comment_url && <a href={c.comment_url} target="_blank" rel="noreferrer" className="flex min-h-9 items-center text-sm font-semibold text-info no-underline">Open on Facebook ↗</a>}
          </li>
        ))}
      </ul>
      {replies.total > replies.shown && (
        <button onClick={() => setLimit((n) => n + 12)} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">Show more</button>
      )}
      <p className="text-xs text-muted">
        Complaints and orders come first.{!replies.tracked && ' Replies you already sent are not tracked yet.'}
      </p>
    </>
  )
}

export function Home() {
  const { session, summary, analysis, error, refresh } = useOutletContext()
  const { playbook } = usePlaybook(session, analysis)
  const [intent, setIntent] = useState(null) // a tile narrows the reply list to one kind of comment
  const replies = useRef(null)
  const filterTo = (kind) => {
    setIntent((cur) => (cur === kind ? null : kind))
    setTimeout(() => replies.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  if (!summary) {
    return error
      ? <ErrorState message={error} onRetry={refresh} />
      : <><Skeleton className="h-40" /><Skeleton className="h-20" /><Skeleton className="h-32" /></>
  }

  // Counts come from comment classification; until it has run they would read as a false "0".
  const ready = summary.classified > 0
  const n = (v) => (ready ? v : '–')

  return (
    <>
      <PostToday playbook={playbook} />

      <section className="grid grid-cols-3 gap-2.5">
        <Tile to="/orders" value={n(summary.intents.order_intent)} label="possible orders" color="text-accent" />
        <Tile onClick={() => filterTo('price_question')} active={intent === 'price_question'} value={n(summary.intents.price_question)} label="price questions waiting" color="text-info" />
        <Tile onClick={() => filterTo('complaint')} active={intent === 'complaint'} value={n(summary.intents.complaint)} label="complaints to handle" color="text-warn" />
      </section>

      {!session.demo && <StockAlerts pageId={session.page.id} analysis={analysis} />}

      <Drafts session={session} analysis={analysis} />

      <section ref={replies} className="flex scroll-mt-4 flex-col gap-2.5">
        <h2 className="text-[17px] font-bold">Needs your reply</h2>
        <Replies pageId={session.page.id} ready={ready} total={summary.comments} intent={intent} onClear={() => setIntent(null)} />
      </section>
    </>
  )
}
