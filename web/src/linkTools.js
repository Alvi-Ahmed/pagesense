// Checks for the optional link field; the server checks again.
export function linkProblem(value) {
  const text = value.trim()
  if (!text) return null
  let url
  try { url = new URL(text) } catch { return 'This is not a proper web address. Start it with https://' }
  if (url.protocol !== 'https:') return 'The link must start with https://'
  if (/\s/.test(text) || !url.hostname.includes('.')) return 'That link does not look right.'
  return null
}
