import { useCallback, useEffect, useState } from 'react'
import { get, post } from './api'

const POLL_MS = 3000

// Sync + analysis status and header counts for the connected page. Polls every 3 s while
// something is running, otherwise loads once. Real mode also starts the first sync.
export function usePageStatus(session) {
  const { page, token, days, demo } = session
  const [sync, setSync] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [s, a, sum] = await Promise.all([
        demo ? { status: 'idle' } : get(`/pages/${page.id}/sync`),
        get(`/pages/${page.id}/analysis`),
        get(`/pages/${page.id}/summary`),
      ])
      setSync(s); setAnalysis(a); setSummary(sum); setError(null)
      return { s, a }
    } catch (e) {
      setError(e.message)
      return null
    }
  }, [page.id, demo])

  // First load: attach to a running sync, or start one if this page has never synced.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cur = await refresh()
      if (cancelled || demo || !cur || !token) return
      if (cur.s.status === 'idle' && cur.a.status === 'idle') {
        try {
          const started = await post(`/pages/${page.id}/sync`, { accessToken: token, days })
          if (!cancelled) setSync(started)
        } catch (e) { if (!cancelled) setError(e.message) }
      } else if (cur.s.status !== 'running' && !['queued', 'running'].includes(cur.a.status)) {
        // An already analysed page may be missing stages added since, or have new items: the server runs only what is needed.
        try {
          const a = await post(`/pages/${page.id}/analysis`, { accessToken: token })
          if (!cancelled) setAnalysis(a)
        } catch (e) { if (!cancelled) setError(e.message) }
      }
    })()
    return () => { cancelled = true }
  }, [refresh, demo, token, days, page.id])

  const active = sync?.status === 'running' || ['queued', 'running'].includes(analysis?.status)
  // After a sync ends the analysis job appears server-side; keep polling until it has.
  useEffect(() => {
    if (!active) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [active, refresh])

  const retry = async () => {
    setError(null)
    try {
      if (sync?.status === 'error') setSync(await post(`/pages/${page.id}/sync`, { accessToken: token, days }))
      else setAnalysis(await post(`/pages/${page.id}/analysis`, { accessToken: token }))
    } catch (e) { setError(e.message) }
  }

  // Re-analyse: every stage again, on every post and comment.
  const reanalyse = async () => {
    setError(null)
    try { setAnalysis(await post(`/pages/${page.id}/analysis`, { accessToken: token, force: true })) }
    catch (e) { setError(e.message) }
  }

  return { sync, analysis, summary, error, retry, refresh, reanalyse }
}
