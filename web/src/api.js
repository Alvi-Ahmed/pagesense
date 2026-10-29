export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

export async function request(path, body, method = 'POST') {
  const res = await fetch(`${API_URL}${path}`, body && {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => {
    throw new Error(`Backend returned a non-JSON response (HTTP ${res.status}) from ${res.url}`)
  })
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}
export const get = (path) => request(path)
export const post = request
export const patch = (path, body) => request(path, body, 'PATCH')
