export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export async function request(path, body, method = 'POST', headers = {}) {
  const options = body !== undefined || Object.keys(headers).length
    ? { method, headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) }
    : undefined
  const res = await fetch(`${API_URL}${path}`, options)
  const data = await res.json().catch(() => {
    throw new Error(`Backend returned a non-JSON response (HTTP ${res.status}) from ${res.url}`)
  })
  if (!res.ok) {
    // the login ran out: the app listens for this and takes the owner back to the login screen
    if (res.status === 401 && data.code === 'session_expired') window.dispatchEvent(new Event('pagesense:session-expired'))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}
export const get = (path) => request(path)
export const post = request
// Reads of private data (orders hold customers' phone numbers) prove who is asking with a header.
export const getAuth = (path, token) => request(path, undefined, 'GET', token ? { 'x-access-token': token } : {})
export const patch = (path, body) => request(path, body, 'PATCH')
