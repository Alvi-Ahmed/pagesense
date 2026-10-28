import { useEffect, useState } from 'react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

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
      <div className={`rounded-lg px-4 py-3 text-sm ${badge}`}>
        {status.state === 'loading' && 'Checking backend…'}
        {status.state === 'ok' && `Backend online (${status.data.service})`}
        {status.state === 'error' && `Backend unreachable: ${status.message}`}
      </div>
    </main>
  )
}
