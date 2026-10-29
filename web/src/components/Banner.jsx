const STAGE_LABEL = { tagging: 'reading photos', classification: 'reading comments', playbook: 'building your playbook' }

// Slim status strip shown above every screen while syncing/analysing, or when either fails.
export function Banner({ sync, analysis, error, canRetry, onRetry }) {
  let tone = null
  let text = null
  let retry = false

  if (error) {
    tone = 'error'; text = `Could not reach the server: ${error}`
  } else if (sync?.status === 'error') {
    tone = 'error'; text = `Sync failed: ${sync.error}`; retry = true
  } else if (sync?.status === 'running') {
    tone = 'busy'; text = `Syncing your page… ${sync.posts} posts, ${sync.comments} comments`
  } else if (analysis?.status === 'failed') {
    tone = 'error'; text = `Analysis failed: ${analysis.error}`; retry = true
  } else if (analysis?.status === 'queued') {
    tone = 'busy'; text = 'Analysis starting…'
  } else if (analysis?.status === 'running') {
    tone = 'busy'
    text = analysis.total > 0
      ? `Analyzed ${analysis.processed} of ${analysis.total} · ${STAGE_LABEL[analysis.stage] ?? analysis.stage}`
      : `Analyzing · ${STAGE_LABEL[analysis.stage] ?? analysis.stage ?? 'starting'}`
  }
  if (!tone) return null

  const pct = analysis?.status === 'running' && analysis.total > 0
    ? Math.round((analysis.processed / analysis.total) * 100) : null

  return (
    <div role="status" className={`${tone === 'error' ? 'bg-warn-soft text-warn' : 'bg-info-soft text-info'}`}>
      <div className="flex items-center gap-2 px-5 py-2 text-xs font-semibold">
        {tone === 'busy' && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-info" />}
        <span className="min-w-0 flex-1">{text}</span>
        {retry && canRetry && (
          <button onClick={onRetry} className="shrink-0 rounded-btn bg-warn px-3 py-1.5 text-white">Retry</button>
        )}
      </div>
      {pct !== null && (
        <div className="h-1 bg-info/15"><div className="h-1 bg-info transition-all" style={{ width: `${pct}%` }} /></div>
      )}
    </div>
  )
}
