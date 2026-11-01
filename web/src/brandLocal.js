// The demo's brand lives in the visitor's tab: its logo (a PNG data URL), shop name and color are sent along with each
// preview and never stored.
const KEY = 'pagesense.demoBrand'
const empty = () => ({ shop_name: 'Demo Shop', color: '#12694A', logo: null })

export const localBrand = () => {
  try { return { ...empty(), ...JSON.parse(sessionStorage.getItem(KEY)) } } catch { return empty() }
}
export function setLocalBrand(patch) {
  const next = { ...localBrand(), ...patch }
  try { sessionStorage.setItem(KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
  return next
}
