import { useEffect, useState } from 'react'
import { getAuth, post } from '../api'
import { localBrand } from '../brandLocal'
import { Skeleton } from './ui'

const toggle = (on) => `min-h-11 flex-1 rounded-btn border px-3 text-sm font-bold ${on ? 'border-accent bg-accent-soft text-accent-dark' : 'border-line bg-white text-muted'}`

// The product photo with the shop's logo and a price badge, put in empty space only. Detecting the product takes a few
// seconds once per photo (SAM 3.1); after that every toggle is instant. The demo keeps its brand and result in the tab.
export function BrandedPhoto({ session, source, hint, price, offer, draftId, onSettings }) {
  const demo = session.demo
  const pageId = session.page.id
  const [brand, setBrand] = useState(null)
  const [found, setFound] = useState(null) // { key, boxes }
  const [options, setOptions] = useState({ logo: true, badge: true, format: 'square', region: 0 })
  const [result, setResult] = useState(null)
  const [loadedKey, setLoadedKey] = useState(null)
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)
  const sourceKey = JSON.stringify(source)?.slice(0, 120) ?? ''

  // brand: from the server, or this tab for the demo
  useEffect(() => {
    let cancelled = false
    const done = (b) => { if (!cancelled) setBrand(b) }
    if (demo) Promise.resolve(localBrand()).then((b) => done({ color: b.color, has_logo: !!b.logo, logo: b.logo }))
    else getAuth(`/pages/${pageId}/brand`, session.token).then((b) => done({ color: b.color, has_logo: b.has_logo })).catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, demo, session.token])

  // find the product once per photo
  useEffect(() => {
    if (!brand?.has_logo || !source) return undefined
    let cancelled = false
    post(`/pages/${pageId}/branding/detect`, { source, hint, accessToken: session.token })
      .then((d) => { if (!cancelled) setFound({ key: sourceKey, boxes: d.boxes, phrase: d.phrase_used ?? d.phrase }) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per photo and brand
  }, [brand?.has_logo, sourceKey, pageId])

  // render whenever a setting changes
  const renderKey = `${sourceKey}|${found?.key}|${JSON.stringify(options)}|${price}|${offer}`
  useEffect(() => {
    if (!found || found.key !== sourceKey) return undefined
    let cancelled = false
    post(`/pages/${pageId}/branding/render`, {
      source, boxes: found.boxes, options, price, offer, accessToken: session.token,
      ...(demo && { logo: brand.logo, color: brand.color }),
    })
      .then((r) => { if (!cancelled) { setResult(r); setError(null); setLoadedKey(renderKey); onSettings?.({ source, boxes: found.boxes, options, price, offer, image: r.image }) } })
      .catch((e) => { if (!cancelled) { setError(e.message); setLoadedKey(renderKey) } })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- renderKey covers every input
  }, [renderKey])

  const set = (patch) => { setOptions((o) => ({ ...o, ...patch })); setSaved(null) }
  const working = brand?.has_logo && source && (!found || loadedKey !== renderKey)

  const keep = async () => {
    setError(null)
    try {
      const r = await post(`/pages/${pageId}/drafts/${draftId}/branded`, { source, boxes: found.boxes, options, price, offer, accessToken: session.token })
      setSaved(r)
    } catch (e) { setError(e.message) }
  }

  if (!brand) return <Skeleton className="aspect-square w-full" />
  if (!brand.has_logo) {
    return (
      <div className="flex flex-col gap-2 rounded-card border border-dashed border-line bg-white p-4 text-sm">
        <p className="font-bold">Put your logo on this photo</p>
        <p className="text-muted">Add your logo once in Brand settings and every photo can carry it, with a price badge, without touching the product.</p>
        <button onClick={() => window.dispatchEvent(new Event('pagesense:open-brand'))} className="min-h-11 self-start rounded-btn border border-line bg-white px-4 font-bold">Open Brand settings</button>
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Branded photo">
      <div className="relative overflow-hidden rounded-card bg-track">
        {result ? <img src={result.image} alt="Branded product photo" className={`w-full ${working ? 'opacity-60' : ''}`} style={{ aspectRatio: `${result.width} / ${result.height}` }} />
          : <Skeleton className="aspect-square w-full" />}
        {working && <p role="status" className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-1.5 text-xs font-semibold text-white">{found ? 'Updating…' : 'Finding your product in the photo…'}</p>}
      </div>
      <div className="flex gap-2">
        <button onClick={() => set({ logo: !options.logo })} aria-pressed={options.logo} className={toggle(options.logo)}>Logo {options.logo ? 'on' : 'off'}</button>
        <button onClick={() => set({ badge: !options.badge })} aria-pressed={options.badge} disabled={!price} className={`${toggle(options.badge && !!price)} disabled:opacity-50`}>Price badge {options.badge && price ? 'on' : 'off'}</button>
      </div>
      <div className="flex gap-2">
        <div role="radiogroup" aria-label="Format" className="grid flex-1 grid-cols-2 gap-1 rounded-btn bg-track p-1">
          {[['square', 'Square'], ['portrait', 'Portrait']].map(([id, label]) => (
            <button key={id} role="radio" aria-checked={options.format === id} onClick={() => set({ format: id, region: 0 })}
              className={`min-h-11 rounded-[10px] text-sm font-semibold ${options.format === id ? 'bg-white text-accent-dark shadow-sm' : 'text-muted'}`}>{label}</button>
          ))}
        </div>
        <button onClick={() => set({ region: options.region + 1 })} disabled={!options.logo || (result?.regions?.length ?? 0) < 2}
          className="min-h-11 rounded-btn border border-line bg-white px-3 text-sm font-bold disabled:opacity-50">Move logo</button>
      </div>
      {result?.notes?.length > 0 && <ul className="flex flex-col gap-1 rounded-btn bg-amber-soft px-3 py-2 text-xs text-amber-ink">{result.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {error && <p role="alert" className="text-xs text-warn">{error}</p>}
      <div className="flex gap-2">
        <a href={result?.image} download={`branded-${options.format}.jpg`} aria-disabled={!result}
          className={`flex min-h-11 flex-1 items-center justify-center rounded-btn border border-line bg-white text-sm font-bold text-ink no-underline ${result ? '' : 'pointer-events-none opacity-50'}`}>Download image</a>
        {draftId && !demo && <button onClick={keep} disabled={!found} className="min-h-11 flex-1 rounded-btn bg-accent px-3 text-sm font-bold text-white disabled:opacity-50">{saved ? 'Kept with the draft' : 'Keep with this draft'}</button>}
      </div>
      {result?.logo && <p className="text-[11px] text-muted">Product found as “{found?.phrase}”. The logo is in the {result.logo.region === 'top' || result.logo.region === 'bottom' ? `${result.logo.region} band` : { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' }[result.logo.region]} ({result.logo.variant} version). The product itself is never changed.</p>}
    </section>
  )
}
