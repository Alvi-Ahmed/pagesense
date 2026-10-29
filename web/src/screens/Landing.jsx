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
    const { page } = await post('/auth/select-page', { accessToken: token, pageId: picked.id })
    onConnected({ page, token, days })
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

export function Landing({ onConnected }) {
  const [status, setStatus] = useState({ state: 'loading' })

  useEffect(() => {
    get('/health')
      .then((data) => setStatus({ state: 'ok', data }))
      .catch((err) => setStatus({ state: 'error', message: err.message }))
  }, [])

  const badge = {
    loading: 'bg-track text-muted',
    ok: 'bg-accent-soft text-accent-dark',
    error: 'bg-warn-soft text-warn',
  }[status.state]

  return (
    <main className="mx-auto flex min-h-svh max-w-[430px] flex-col justify-center gap-6 bg-bg px-5 py-10">
      <h1 className="text-4xl font-bold tracking-tight">PageSense</h1>
      <p className="text-lg text-muted">
        An AI marketing analyst for Facebook page sellers. Learns what sells,
        builds your catalog, and writes posts in your voice, in Bangla, English
        or Banglish.
      </p>
      <Connect onConnected={onConnected} />
      <button onClick={() => onConnected(DEMO_SESSION)} className="min-h-11 self-start text-sm text-muted underline">
        Try the demo without logging in
      </button>
      <div className={`rounded-card px-4 py-3 text-sm ${badge}`}>
        {status.state === 'loading' && 'Checking backend…'}
        {status.state === 'ok' && `Backend online (${status.data.service})`}
        {status.state === 'error' && `Backend unreachable: ${status.message}`}
      </div>
    </main>
  )
}
