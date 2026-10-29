import { useOutletContext } from 'react-router-dom'
import { usePlaybook } from '../usePlaybook'
import { EmptyState, ErrorState, ScreenHeader, Skeleton } from '../components/ui'

const ASKS = [
  ['price_question', 'Price'],
  ['size_or_color_request', 'Size or color'],
  ['stock_or_restock', 'Is it in stock?'],
  ['delivery_question', 'Delivery'],
  ['product_question', 'About the product'],
  ['negotiation', 'Discount'],
]

function Card({ title, children }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-white px-4 py-4">
      {title && <h2 className="text-[15px] font-bold">{title}</h2>}
      {children}
    </section>
  )
}

// One bar per group, scaled to the largest; the tick marks the typical post.
function Bars({ groups, average }) {
  const max = Math.max(...groups.map((g) => g.median_engagement), average)
  return (
    <ul className="flex flex-col gap-3">
      {groups.map((g) => (
        <li key={g.value} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold first-letter:uppercase">{g.value}</span>
            <span className="text-xs text-muted">
              {g.posts} posts · {g.vs_typical}
            </span>
          </div>
          <div className="relative h-3 rounded-full bg-track">
            <div className={`h-full rounded-full ${g.engagement_vs_page_pct >= 0 ? 'bg-accent' : 'bg-bar-grey'}`}
              style={{ width: `${Math.max(2, (g.median_engagement / max) * 100)}%` }} />
            <div className="absolute inset-y-[-3px] w-0.5 bg-ink" style={{ left: `${(average / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Asks({ intents }) {
  const rows = ASKS.map(([key, label]) => [label, intents[key] || 0]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  if (!rows.length) return <p className="text-sm text-muted">No buying questions found in the comments yet.</p>
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map(([label, n]) => (
        <li key={label} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 font-semibold">{label}</span>
          <div className="h-2.5 flex-1 rounded-full bg-track">
            <div className="h-full rounded-full bg-info" style={{ width: `${(n / rows[0][1]) * 100}%` }} />
          </div>
          <span className="w-10 text-right text-xs font-bold">{n}</span>
        </li>
      ))}
    </ul>
  )
}

function BoostRow({ post: p, busy, onToggle }) {
  return (
    <li className="flex items-center gap-3">
      <img src={p.photo_url} alt="" loading="lazy" className="size-14 shrink-0 rounded-btn bg-track object-cover" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm">{p.caption || 'No caption'}</p>
        <p className="text-xs text-muted">{Math.round(p.engagement_score)} engagement</p>
      </div>
      <button role="switch" aria-checked={p.is_boosted} aria-label={`Was this boosted? ${p.caption.slice(0, 30)}`}
        disabled={busy} onClick={() => onToggle(p)}
        className={`flex min-h-11 shrink-0 items-center gap-2 rounded-btn px-2 text-xs font-semibold disabled:opacity-50 ${p.is_boosted ? 'text-warn' : 'text-muted'}`}>
        <span className={`flex h-6 w-11 items-center rounded-full p-0.5 transition-colors ${p.is_boosted ? 'bg-warn' : 'bg-bar-grey'}`}>
          <span className={`size-5 rounded-full bg-white transition-transform ${p.is_boosted ? 'translate-x-5' : ''}`} />
        </span>
        {p.is_boosted ? 'Boosted' : 'Organic'}
      </button>
    </li>
  )
}

export function Playbook() {
  const { session, analysis } = useOutletContext()
  const { playbook, error, retry, busy, toggleError, toggleBoosted } = usePlaybook(session, analysis)

  const header = <ScreenHeader title="Your playbook" subtitle="What works on your page" />
  if (error) return <>{header}<ErrorState message={error} onRetry={retry} /></>
  if (!playbook) return <>{header}<Skeleton className="h-28" /><Skeleton className="h-48" /><Skeleton className="h-48" /></>

  if (playbook.status === 'none') {
    const working = ['queued', 'running'].includes(analysis?.status)
    return (
      <>
        {header}
        <EmptyState title={working ? 'Building your playbook…' : 'Your playbook will appear when analysis finishes'}>
          We compare your posts, offers and prices to find what your customers respond to.
        </EmptyState>
      </>
    )
  }

  const { data, summary } = playbook
  const strongest = data.dimensions.find((d) => d.key === data.strongest?.dimension)
  const others = data.dimensions.filter((d) => d !== strongest)

  return (
    <>
      {header}
      {summary?.headline
        ? <p className="rounded-card bg-accent-soft px-4 py-3.5 text-[15px] font-semibold text-accent-dark">{summary.headline}</p>
        : <EmptyState title="The written summary is not ready">The numbers below are up to date. Run the analysis again to get the summary.</EmptyState>}
      <p className="text-xs text-muted">
        Based on {data.basis.posts} posts{data.basis.boosted_excluded > 0 && `; ${data.basis.boosted_excluded} boosted left out`}.
        Bars show the median post (so one viral post cannot skew them); the line is your typical post. Groups with fewer than 3 posts are not shown.
      </p>

      {strongest && (
        <Card title={`Strongest pattern: ${strongest.label.toLowerCase()}`}>
          <Bars groups={strongest.groups} average={data.basis.median_engagement} />
        </Card>
      )}
      {!data.dimensions.length && (
        <EmptyState title="Not enough posts to compare yet">Patterns appear once there are at least 3 posts of each kind.</EmptyState>
      )}

      {summary?.supporting?.length > 0 && (
        <Card title="More we found">
          <ul className="flex flex-col gap-2 text-sm">
            {summary.supporting.map((s) => <li key={s.text} className="border-l-2 border-accent-pale pl-3">{s.text}</li>)}
          </ul>
        </Card>
      )}

      <Card title="What customers ask before buying">
        {data.price?.share_pct > 0 && (
          <p className="text-sm font-semibold text-info">
            {data.price.share_pct}% of comments ask the price ({data.price.question_comments} of {data.price.classified_comments}).
          </p>
        )}
        <Asks intents={data.intents} />
      </Card>

      {summary?.actions?.length > 0 && (
        <Card title="Do this next">
          <ol className="flex flex-col gap-2.5">
            {summary.actions.map((a, i) => (
              <li key={a} className="flex gap-3 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">{i + 1}</span>
                <span className="pt-0.5">{a}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card title="Was this boosted?">
        <p className="text-sm text-muted">Paid reach inflates engagement. Mark boosted posts and they are left out of every pattern.</p>
        <ul className="flex flex-col gap-2">
          {data.top_posts.map((p) => <BoostRow key={p.id} post={p} busy={busy} onToggle={toggleBoosted} />)}
        </ul>
        {busy && <p role="status" className="text-xs text-muted">Updating your playbook…</p>}
        {toggleError && <ErrorState message={toggleError} />}
      </Card>

      {others.length > 0 && (
        <details className="rounded-card border border-line bg-white px-4 py-3.5">
          <summary className="min-h-11 cursor-pointer text-[15px] font-bold leading-[44px]">All other patterns</summary>
          <div className="flex flex-col gap-5 pb-2">
            {others.map((d) => (
              <div key={d.key} className="flex flex-col gap-2.5">
                <h3 className="text-sm font-bold">{d.label}</h3>
                <Bars groups={d.groups} average={data.basis.median_engagement} />
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  )
}
