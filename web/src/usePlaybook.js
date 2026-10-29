import { useEffect, useState } from 'react'
import { get } from './api'

// Cached playbook for the connected page. Reloads when an analysis run finishes (it replaces the cache).
export function usePlaybook(pageId, analysis) {
  const [playbook, setPlaybook] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    get(`/pages/${pageId}/playbook`)
      .then((p) => { if (!cancelled) { setPlaybook(p); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, analysis?.finished_at, attempt])

  return { playbook, setPlaybook, error, retry: () => setAttempt((n) => n + 1) }
}
