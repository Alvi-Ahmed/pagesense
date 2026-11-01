// The caption variants as swipeable cards: each has its angle, the playbook pattern behind it and the caption.
// Picking one makes it the editable draft below. Nothing here promises reach or engagement.
const bestTimeText = (t) => {
  const parts = [t.weekday && `${t.weekday.value}s`, t.time_of_day && `in the ${t.time_of_day.value}`].filter(Boolean)
  const posts = Math.max(t.weekday?.posts ?? 0, t.time_of_day?.posts ?? 0)
  return `${parts.join(' ')} (based on ${posts} posts)`
}

export function VariantCards({ variants, selected, onSelect, bestTime, disabled }) {
  if (!variants?.length) return null
  return (
    <section className="flex flex-col gap-2.5" aria-label="Caption versions">
      <h2 className="text-[15px] font-bold">{variants.length === 1 ? 'Your caption' : `${variants.length} versions to choose from`}</h2>
      {variants.length > 1 && <p className="text-xs text-muted">Swipe to compare. Choose one, then edit it below.</p>}
      <ul className="-mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-2">
        {variants.map((v) => {
          const on = v.angle === selected
          return (
            <li key={v.id} className={`flex w-[82%] shrink-0 snap-center flex-col gap-2 rounded-card border bg-white p-3.5 ${on ? 'border-accent ring-2 ring-accent-pale' : 'border-line'}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold text-white">{v.angle_label}</span>
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-dark">{v.pattern.pattern}: {v.pattern.value}</span>
              </div>
              <p className="text-xs font-semibold text-muted">{v.basis}</p>
              <p className="text-sm">{v.reason}</p>
              <p className="line-clamp-6 whitespace-pre-wrap rounded-btn bg-track px-3 py-2.5 text-sm leading-relaxed">{v.caption}</p>
              <button onClick={() => onSelect(v)} disabled={disabled || on} aria-pressed={on}
                className={`mt-auto min-h-11 rounded-btn px-4 text-sm font-bold ${on ? 'bg-accent-soft text-accent-dark' : 'bg-accent text-white'} disabled:opacity-70`}>
                {on ? 'Chosen' : 'Use this one'}
              </button>
            </li>
          )
        })}
      </ul>
      {bestTime && <p className="rounded-btn bg-info-soft px-3 py-2.5 text-sm text-info">Best time to post, from your page: {bestTimeText(bestTime)}.</p>}
    </section>
  )
}
