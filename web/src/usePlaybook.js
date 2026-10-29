import { useEffect, useState } from 'react'
import { get, post } from './api'

const KEY = 'pagesense.demoBoosted'

const loadFlags = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || {} } catch { return {} }
}
const saveFlags = (flags) => {
  try { sessionStorage.setItem(KEY, JSON.stringify(flags)) } catch { /* storage unavailable */ }
}

// Cached playbook for the connected page, reloaded when an analysis run finishes.
// Boosted toggles: a real page saves them on the server; the demo page is shared and read-only, so a
// visitor's flags stay in their own tab (sessionStorage) and the server only previews the result.
export function usePlaybook(session, analysis) {
  const pageId = session.page.id
  const demo = !!session.demo
  const [playbook, setPlaybook] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [flags, setFlags] = useState(() => (demo ? loadFlags() : {}))
  const [loadedKey, setLoadedKey] = useState(null)
  const [busy, setBusy] = useState(false)
  const [toggleError, setToggleError] = useState(null)

  const key = `${analysis?.finished_at}|${attempt}|${JSON.stringify(flags)}`
  useEffect(() => {
    let cancelled = false
    const request = demo && Object.keys(flags).length
      ? post(`/pages/${pageId}/playbook/preview`, { boosted: flags })
      : get(`/pages/${pageId}/playbook`)
    request
      .then((p) => { if (!cancelled) { setPlaybook(p); setError(null); setLoadedKey(key) } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoadedKey(key) } })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` already covers flags, attempt and analysis
  }, [pageId, demo, key])

  const toggleBoosted = async (p) => {
    setToggleError(null)
    if (demo) {
      const next = { ...flags, [p.id]: !p.is_boosted }
      saveFlags(next)
      setFlags(next)
      return
    }
    setBusy(true)
    try {
      setPlaybook(await post(`/pages/${pageId}/posts/${p.id}/boosted`, { boosted: !p.is_boosted, accessToken: session.token }))
    } catch (e) { setToggleError(e.message) }
    setBusy(false)
  }

  return {
    playbook, error, toggleError, toggleBoosted,
    busy: busy || (playbook !== null && loadedKey !== key), // demo previews run on the server
    retry: () => setAttempt((n) => n + 1),
  }
}
