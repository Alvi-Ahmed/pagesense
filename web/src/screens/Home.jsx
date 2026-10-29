import { useEffect, useState } from 'react'
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

function Tile({ value, label, color }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-white px-3 py-3.5">
      <span className={`text-[26px] font-bold ${color}`}>{value}</span>
      <span className="text-xs leading-snug text-muted">{label}</span>
    </div>
  )
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
      <h2 className="text-[17px] font-bold">Your drafts</h2>
      <ul className="flex flex-col gap-2">
        {drafts.slice(0, 4).map((d) => (
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

function Replies({ pageId, ready, total }) {
  const [replies, setReplies] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    get(`/pages/${pageId}/replies`)
      .then((r) => { if (!cancelled) { setReplies(r); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, ready, attempt])

  if (!ready) return <EmptyState title="Nothing to reply to yet">Comments that need an answer show up here once {total} comments are read.</EmptyState>
  if (error) return <ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} />
  if (!replies) return <Skeleton className="h-32" />
  if (!replies.items.length) return <EmptyState title="Nothing to reply to">No open questions or complaints in your comments.</EmptyState>
  return (
    <>
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
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        Complaints and orders come first.{!replies.tracked && ' Replies you already sent are not tracked yet.'}
      </p>
    </>
  )
}

export function Home() {
  const { session, summary, analysis, error, refresh } = useOutletContext()
  const { playbook } = usePlaybook(session, analysis)

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
        <Tile value={n(summary.intents.order_intent)} label="possible orders" color="text-accent" />
        <Tile value={n(summary.intents.price_question)} label="price questions waiting" color="text-info" />
        <Tile value={n(summary.intents.complaint)} label="complaints to handle" color="text-warn" />
      </section>

      <Drafts session={session} analysis={analysis} />

      <section className="flex flex-col gap-2.5">
        <h2 className="text-[17px] font-bold">Needs your reply</h2>
        <Replies pageId={session.page.id} ready={ready} total={summary.comments} />
      </section>
    </>
  )
}
