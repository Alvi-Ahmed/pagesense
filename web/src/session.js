// The connected page, kept per browser tab (the Facebook token is short-lived).
const KEY = 'pagesense.session'

export const loadSession = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)) } catch { return null }
}

export const saveSession = (s) => {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s))
    else sessionStorage.removeItem(KEY)
  } catch { /* storage unavailable */ }
}

export const DEMO_SESSION = { page: { id: 'demo', name: 'Demo Shop' }, token: null, demo: true }
