import { useEffect, useState } from 'react'
import { facebookLogin } from './facebook'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

async function request(path, body) {
  const res = await fetch(`${API_URL}${path}`, body && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => {
    throw new Error(`Backend returned a non-JSON response (HTTP ${res.status}) from ${res.url}`)
  })
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
const get = (path) => request(path)
const post = request

// Keep the connected page across reloads (per tab; the token is short-lived).
const loadSession = () => {
  try { return JSON.parse(sessionStorage.getItem('pagesense.session')) } catch { return null }
}
const saveSession = (s) => {
  try { s ? sessionStorage.setItem('pagesense.session', JSON.stringify(s)) : sessionStorage.removeItem('pagesense.session') } catch { /* storage unavailable */ }
}

const RANGES = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 3 months', hint: 'Recommended' },
  { days: 180, label: 'Last 6 months' },
  { days: 365, label: 'Last year' },
  { days: 0, label: 'Everything', hint: 'Slow on older pages' },
]
const rangeLabel = (days) => RANGES.find((r) => r.days === (days || 0))?.label ?? `Last ${days} days`

function SyncWidget({ page, token, days }) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState(false)
  const status = job?.status

  // Start a sync if none has run yet, otherwise just attach to the one in progress.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let j = await get(`/pages/${page.id}/sync`)
        if (j.status === 'idle' && token) j = await post(`/pages/${page.id}/sync`, { accessToken: token, days })
        if (!cancelled) setJob(j)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => { cancelled = true }
  }, [page.id, token, days])

  // Poll while running.
  useEffect(() => {
    if (status !== 'running') return
    const timer = setInterval(() => {
      get(`/pages/${page.id}/sync`).then(setJob).catch((e) => setError(e.message))
    }, 1500)
    return () => clearInterval(timer)
  }, [page.id, status])

  const retry = async () => {
    setError(null)
    try { setJob(await post(`/pages/${page.id}/sync`, { accessToken: token, days })) } catch (e) { setError(e.message) }
  }

  const failed = status === 'error' || error
  const label = failed ? 'Sync failed' : status === 'done' ? 'Page synced' : 'Syncing your page…'
  const dot = failed ? 'bg-red-500' : status === 'done' ? 'bg-emerald-500' : 'animate-pulse bg-blue-600'

  return (
    <div className="fixed right-4 bottom-4 z-10 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white text-sm shadow-lg">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-medium">{label}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-slate-200 px-3 py-2 text-slate-600">
          {job && <p className="text-xs">{rangeLabel(job.days)}</p>}
          {job && <p>{job.posts} posts, {job.comments}{job.commentsExpected > 0 && ` / ~${job.commentsExpected}`} comments</p>}
          {status === 'running' && <p className="text-xs">This runs on the server. Keep using the app.</p>}
          {failed && <p className="text-red-700">{error || job.error}</p>}
          {failed && token && <button onClick={retry} className="rounded bg-blue-600 px-3 py-1.5 text-white">Try again</button>}
        </div>
      )}
    </div>
  )
}

function Dashboard({ session, onDisconnect }) {
  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col gap-4 px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">{session.page.name}</h1>
      <p className="text-slate-600">
        {session.demo
          ? 'Demo mode: a snapshot of a real seller page, with customer details removed.'
          : "We're learning from your posts and comments in the background. You can keep going while it finishes."}
      </p>
      <button onClick={onDisconnect} className="self-start text-sm text-slate-500 underline">
        Disconnect page
      </button>
      {!session.demo && <SyncWidget page={session.page} token={session.token} days={session.days} />}
    </main>
  )
}

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
          <p className="font-medium">How far back should we learn from {picked.name}?</p>
          <p className="text-sm text-slate-600">
            Older history takes longer and costs more. You can sync more later.
          </p>
          {RANGES.map((r) => (
            <label key={r.days} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 ${days === r.days ? 'border-blue-600 bg-blue-50' : 'border-slate-300'}`}>
              <input type="radio" name="range" checked={days === r.days} onChange={() => setDays(r.days)} />
              <span className="flex-1">{r.label}</span>
              {r.hint && <span className="text-xs text-slate-500">{r.hint}</span>}
            </label>
          ))}
          <button disabled={busy} onClick={confirm}
            className="rounded-lg bg-blue-600 px-4 py-3 font-medium text-white disabled:opacity-50">
            {busy ? 'Working…' : 'Start'}
          </button>
          <button disabled={busy} onClick={() => setPicked(null)} className="text-sm text-slate-500 underline">
            Choose a different page
          </button>
        </>
      ) : pages ? (
        <>
          <p className="font-medium">Choose a page</p>
          {pages.length === 0 && <p className="text-slate-600">No pages found on this account.</p>}
          {pages.map((p) => (
            <button key={p.id} disabled={busy} onClick={() => setPicked(p)}
              className="rounded-lg border border-slate-300 px-4 py-3 text-left disabled:opacity-50">
              {p.name}
            </button>
          ))}
        </>
      ) : (
        <button disabled={busy} onClick={login}
          className="rounded-lg bg-blue-600 px-4 py-3 font-medium text-white disabled:opacity-50">
          {busy ? 'Working…' : 'Continue with Facebook'}
        </button>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  )
}

function Landing({ onConnected }) {
  const [status, setStatus] = useState({ state: 'loading' })

  useEffect(() => {
    get('/health')
      .then((data) => setStatus({ state: 'ok', data }))
      .catch((err) => setStatus({ state: 'error', message: err.message }))
  }, [])

  const badge = {
    loading: 'bg-slate-200 text-slate-700',
    ok: 'bg-emerald-100 text-emerald-800',
    error: 'bg-red-100 text-red-800',
  }[status.state]

  return (
    <main className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-4xl font-semibold tracking-tight">PageSense</h1>
      <p className="text-lg text-slate-600">
        An AI marketing analyst for Facebook page sellers. Learns what sells,
        builds your catalog, and writes posts in your voice, in Bangla, English
        or Banglish.
      </p>
      <Connect onConnected={onConnected} />
      <button
        onClick={() => onConnected({ page: { id: 'demo', name: 'Demo Shop' }, token: null, demo: true })}
        className="self-start text-sm text-slate-600 underline"
      >
        Try the demo without logging in
      </button>
      <div className={`rounded-lg px-4 py-3 text-sm ${badge}`}>
        {status.state === 'loading' && 'Checking backend…'}
        {status.state === 'ok' && `Backend online (${status.data.service})`}
        {status.state === 'error' && `Backend unreachable: ${status.message}`}
      </div>
    </main>
  )
}

export default function App() {
  const [session, setSession] = useState(loadSession)

  const update = (s) => { saveSession(s); setSession(s) }

  return session
    ? <Dashboard session={session} onDisconnect={() => update(null)} />
    : <Landing onConnected={update} />
}
