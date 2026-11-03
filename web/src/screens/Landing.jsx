import { useEffect, useState } from 'react'
import { facebookLogin } from '../facebook'
import { get, post } from '../api'
import { DEMO_SESSION } from '../session'

const RANGES = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 3 months', hint: 'Recommended' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last year' },
  { days: 0, label: 'Everything', hint: 'Slow on older pages' },
]

const primary = 'min-h-12 rounded-btn bg-accent px-4 font-bold text-white disabled:opacity-50'

function Connect({ onConnected }) {
  const [token, setToken] = useState(null)
  const [pages, setPages] = useState(null)
  const [picked, setPicked] = useState(null)
  const [days, setDays] = useState(90)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const login = () => run(async () => {
    const accessToken = await facebookLogin()
    const { pages } = await post('/auth/facebook', { accessToken })
    setToken(accessToken)
    setPages(pages)
  })

  const confirm = () => run(async () => {
    const { page, session } = await post('/auth/select-page', { accessToken: token, pageId: picked.id })
    onConnected({ page, token: session ?? token, days }) // our own session token outlives Facebook's short login token
  })

  return (
    <section className="flex flex-col gap-3">
      {picked ? (
        <>
          <p className="font-bold">How far back should we learn from {picked.name}?</p>
          <p className="text-sm text-muted">Older history takes longer and costs more. You can sync more later.</p>
          {RANGES.map((r) => (
            <label key={r.days} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-card border px-4 py-3 ${days === r.days ? 'border-accent bg-accent-soft' : 'border-line bg-white'}`}>
              <input type="radio" name="range" checked={days === r.days} onChange={() => setDays(r.days)} />
              <span className="flex-1">{r.label}</span>
              {r.hint && <span className="text-xs text-muted">{r.hint}</span>}
            </label>
          ))}
          <button disabled={busy} onClick={confirm} className={primary}>{busy ? 'Working…' : 'Start'}</button>
          <button disabled={busy} onClick={() => setPicked(null)} className="min-h-11 text-sm text-muted underline">
            Choose a different page
          </button>
        </>
      ) : pages ? (
        <>
          <p className="font-bold">Choose a page</p>
          {pages.length === 0 && <p className="text-muted">No pages found on this account.</p>}
          {pages.map((p) => (
            <button key={p.id} disabled={busy} onClick={() => setPicked(p)}
              className="min-h-12 rounded-card border border-line bg-white px-4 text-left disabled:opacity-50">
              {p.name}
            </button>
          ))}
        </>
      ) : (
        <button disabled={busy} onClick={login} className={primary}>
          {busy ? 'Working…' : 'Continue with Facebook'}
        </button>
      )}
      {error && <p role="alert" className="text-sm text-warn">{error}</p>}
    </section>
  )
}

export function Landing({ onConnected, notice }) {
  const [status, setStatus] = useState({ state: 'loading' })

  useEffect(() => {
    get('/health')
      .then((data) => setStatus({ state: 'ok', data }))
      .catch((err) => setStatus({ state: 'error', message: err.message }))
  }, [])

  const dot = { loading: 'bg-muted', ok: 'bg-accent', error: 'bg-warn' }[status.state]

  return (
    <main className="mx-auto flex min-h-svh max-w-[430px] flex-col bg-bg px-6 pt-10 pb-6">
      <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
        <h1 className="w-full max-w-[340px]"><img src="/logo-full.png" alt="PageSense" className="w-full mix-blend-multiply" /></h1>
        <p className="max-w-[320px] text-[17px] leading-relaxed text-muted">
          Your AI marketing analyst. Learns what sells on your Facebook page and writes posts in your voice, in Bangla, English or Banglish.
        </p>
      </div>
      <div className="flex flex-col gap-3 pt-8">
        {notice && <p role="alert" className="rounded-card bg-amber-soft px-4 py-3 text-sm font-semibold text-amber-ink">{notice}</p>}
        <Connect onConnected={onConnected} />
        <button onClick={() => onConnected(DEMO_SESSION)}
          className="min-h-12 rounded-btn border border-line bg-white px-4 font-bold text-ink">
          Try the demo without logging in
        </button>
      </div>
      <p className="flex items-center justify-center gap-2 pt-6 text-xs text-muted">
        <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
        {status.state === 'loading' && 'Checking backend…'}
        {status.state === 'ok' && 'Backend online'}
        {status.state === 'error' && `Backend unreachable: ${status.message}`}
      </p>
    </main>
  )
}
