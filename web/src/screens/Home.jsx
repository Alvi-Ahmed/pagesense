import { useOutletContext } from 'react-router-dom'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'

function Tile({ value, label, color }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-white px-3 py-3.5">
      <span className={`text-[26px] font-bold ${color}`}>{value}</span>
      <span className="text-xs leading-snug text-muted">{label}</span>
    </div>
  )
}

export function Home() {
  const { summary, error, refresh } = useOutletContext()

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
      <EmptyState title="Your first post idea is on its way">
        A suggestion for what to post today appears here when analysis finishes.
      </EmptyState>

      <section className="grid grid-cols-3 gap-2.5">
        <Tile value={n(summary.intents.order_intent)} label="possible orders" color="text-accent" />
        <Tile value={n(summary.intents.price_question)} label="price questions waiting" color="text-info" />
        <Tile value={n(summary.intents.complaint)} label="complaints to handle" color="text-warn" />
      </section>

      <section className="flex flex-col gap-2.5">
        <h2 className="text-[17px] font-bold">Needs your reply</h2>
        <EmptyState title="Nothing to reply to yet">
          Comments that need an answer show up here once {summary.comments} comments are read.
        </EmptyState>
      </section>
    </>
  )
}
