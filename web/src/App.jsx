import { useEffect, useState } from 'react'
import { facebookLogin } from './facebook'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

async function get(path) {
  const res = await fetch(`${API_URL}${path}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function post(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function Sync({ page, token }) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)
  const running = job?.status === 'running'

  // Poll while a sync is running (also picks up one already in progress).
  useEffect(() => {
    let timer
    const tick = async () => {
      try {
        const j = await get(`/pages/${page.id}/sync`)
        setJob(j)
        if (j.status === 'running') timer = setTimeout(tick, 1500)
      } catch (e) {
        setError(e.message)
      }
    }
    tick()
    return () => clearTimeout(timer)
  }, [page.id, running])

  const start = async () => {
    setError(null)
    try {
      setJob(await post(`/pages/${page.id}/sync`, { accessToken: token }))
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button onClick={start} disabled={running}
        className="rounded-lg bg-blue-600 px-4 py-3 font-medium text-white disabled:opacity-50">
        {running ? 'Syncing…' : job?.status === 'done' ? 'Sync again' : 'Sync page data'}
      </button>
      {running && (
        <div className="h-2 overflow-hidden rounded bg-slate-200">
          <div className="h-full w-1/3 animate-pulse rounded bg-blue-600" />
        </div>
      )}
      {job && job.status !== 'idle' && (
        <p className="text-sm text-slate-600">
          {job.posts} posts, {job.comments} comments
          {job.status === 'done' && ' — done'}
          {job.status === 'error' && ` — failed: ${job.error}`}
        </p>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  )
}

function Connect() {
  const [token, setToken] = useState(null)
  const [pages, setPages] = useState(null)
  const [connected, setConnected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const login = () =>
    run(async () => {
      const accessToken = await facebookLogin()
      const { pages } = await post('/auth/facebook', { accessToken })
      setToken(accessToken)
      setPages(pages)
    })

  const choose = (pageId) =>
    run(async () => {
      const { page } = await post('/auth/select-page', { accessToken: token, pageId })
      setConnected(page)
      setPages(null)
    })

  const btn =
    'rounded-lg bg-blue-600 px-4 py-3 font-medium text-white disabled:opacity-50'

  return (
    <section className="flex flex-col gap-3">
      {connected ? (
        <>
          <p className="rounded-lg bg-emerald-100 px-4 py-3 text-emerald-800">
            Connected: {connected.name}
          </p>
          <Sync page={connected} token={token} />
        </>
      ) : pages ? (
        <>
          <p className="font-medium">Choose a page</p>
          {pages.length === 0 && (
            <p className="text-slate-600">No pages found on this account.</p>
          )}
          {pages.map((p) => (
            <button key={p.id} disabled={busy} onClick={() => choose(p.id)}
              className="rounded-lg border border-slate-300 px-4 py-3 text-left disabled:opacity-50">
              {p.name}
            </button>
          ))}
        </>
      ) : (
        <button disabled={busy} onClick={login} className={btn}>
          {busy ? 'Working…' : 'Continue with Facebook'}
        </button>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </section>
  )
}

export default function App() {
  const [status, setStatus] = useState({ state: 'loading' })

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
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
      <Connect />
      <div className={`rounded-lg px-4 py-3 text-sm ${badge}`}>
        {status.state === 'loading' && 'Checking backend…'}
        {status.state === 'ok' && `Backend online (${status.data.service})`}
        {status.state === 'error' && `Backend unreachable: ${status.message}`}
      </div>
    </main>
  )
}
