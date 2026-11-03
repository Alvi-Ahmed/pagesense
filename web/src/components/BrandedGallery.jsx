import { useEffect, useState } from 'react'
import { getAuth, post } from '../api'
import { localBrand } from '../brandLocal'
import { zipBlob } from '../zip'
import { Skeleton } from './ui'

const toggle = (on) => `min-h-11 flex-1 rounded-btn border px-3 text-sm font-bold ${on ? 'border-accent bg-accent-soft text-accent-dark' : 'border-line bg-white text-muted'}`
const REGION = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right', top: 'top band', bottom: 'bottom band' }

// The product photos with the shop's logo and a price badge, put in empty space only. Every image gets the same settings,
// but the product is found in each image on its own (SAM 3.1), so the logo never lands on the product in any of them.
// The price badge is on the cover (the first image) unless "badge on all" is chosen. sources: [{ id, source }] in order.
// Detecting takes a few seconds once per photo; after that every toggle is quick. The demo keeps everything in the tab.
export function BrandedGallery({ session, sources, hint, price, offer, draftId }) {
  const demo = session.demo
  const pageId = session.page.id
  const [brand, setBrand] = useState(null)
  const [found, setFound] = useState({}) // id -> { boxes, phrase } | { error }
  const [options, setOptions] = useState({ logo: true, badge: true, badgeAll: false, format: 'square', region: 0 })
  const [shown, setShown] = useState({ key: null, items: {} }) // the last finished set of renders
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  useEffect(() => {
    let cancelled = false
    const done = (b) => { if (!cancelled) setBrand(b) }
    if (demo) Promise.resolve(localBrand()).then((b) => done({ color: b.color, has_logo: !!b.logo, logo: b.logo }))
    else getAuth(`/pages/${pageId}/brand`, session.token).then((b) => done({ color: b.color, has_logo: b.has_logo })).catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, demo, session.token])

  // find the product in every photo that has not been looked at yet (one request, one generation)
  const missing = sources.filter((s) => !found[s.id])
  const missingKey = missing.map((s) => s.id).join()
  useEffect(() => {
    if (!brand?.has_logo || !missing.length) return undefined
    let cancelled = false
    post(`/pages/${pageId}/branding/detect-many`, { sources: missing.map((s) => s.source), hint, accessToken: session.token })
      .then((r) => { if (!cancelled) setFound((f) => ({ ...f, ...Object.fromEntries(missing.map((s, i) => [s.id, r.items[i]?.error ? { error: r.items[i].error } : { boxes: r.items[i].boxes, phrase: r.items[i].phrase_used ?? r.items[i].phrase }])) })) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per new photo
  }, [brand?.has_logo, missingKey, pageId])

  const ready = sources.filter((s) => found[s.id]?.boxes)
  const renderKey = JSON.stringify([ready.map((s) => s.id), options, price, offer])
  useEffect(() => {
    if (!ready.length) return undefined
    let cancelled = false
    ;(async () => {
      const items = {}
      let next = 0
      await Promise.all(Array.from({ length: Math.min(3, ready.length) }, async () => {
        for (let k; (k = next++) < ready.length;) {
          const s = ready[k]
          const cover = sources.indexOf(s) === 0
          try {
            items[s.id] = await post(`/pages/${pageId}/branding/render`, {
              source: s.source, boxes: found[s.id].boxes, price, offer, accessToken: session.token,
              options: { logo: options.logo, badge: options.badge && (cover || options.badgeAll), format: options.format, region: options.region },
              ...(demo && { logo: brand.logo, color: brand.color }),
            })
          } catch (e) { items[s.id] = { error: e.message } }
        }
      }))
      if (!cancelled) { setShown({ key: renderKey, items }); setError(null) }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- renderKey covers every input
  }, [renderKey])

  const set = (patch) => { setOptions((o) => ({ ...o, ...patch })); setSaved(null) }
  const waiting = !!missing.length || shown.key !== renderKey
  const rendered = sources.map((s) => ({ s, r: shown.items[s.id] })).filter((x) => x.r?.image)
  const regions = Math.max(0, ...rendered.map((x) => x.r.regions?.length ?? 0))
  const notes = rendered.flatMap(({ s, r }) => (r.notes ?? []).map((n) => `Image ${sources.indexOf(s) + 1}: ${n}`))

  const keep = async () => {
    setError(null)
    try {
      const images = ready.map((s) => ({ source: s.source, boxes: found[s.id].boxes, options: { badge: options.badge && (sources.indexOf(s) === 0 || options.badgeAll) } }))
      const r = await post(`/pages/${pageId}/drafts/${draftId}/branded-many`, { images, options: { logo: options.logo, format: options.format, region: options.region }, price, offer, accessToken: session.token })
      setSaved(r)
    } catch (e) { setError(e.message) }
  }
  const downloadAll = () => {
    const url = URL.createObjectURL(zipBlob(rendered.map(({ s, r }) => ({ name: `image-${sources.indexOf(s) + 1}${sources.indexOf(s) === 0 ? '-cover' : ''}-${options.format}.jpg`, dataUrl: r.image }))))
    const a = Object.assign(document.createElement('a'), { href: url, download: `branded-images-${options.format}.zip` })
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  if (!brand) return <Skeleton className="aspect-square w-full" />
  if (!brand.has_logo) {
    return (
      <div className="flex flex-col gap-2 rounded-card border border-dashed border-line bg-white p-4 text-sm">
        <p className="font-bold">Put your logo on {sources.length > 1 ? 'these photos' : 'this photo'}</p>
        <p className="text-muted">Add your logo once in Brand settings and every photo can carry it, with a price badge, without touching the product.</p>
        <button onClick={() => window.dispatchEvent(new Event('pagesense:open-brand'))} className="min-h-11 self-start rounded-btn border border-line bg-white px-4 font-bold">Open Brand settings</button>
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Branded photos">
      <div className={`grid gap-2 ${rendered.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {sources.map((s, i) => {
          const r = shown.items[s.id]
          const f = found[s.id]
          return (
            <figure key={s.id} className={`relative m-0 overflow-hidden rounded-card bg-track ${i === 0 && sources.length > 1 ? 'col-span-2' : ''}`}>
              {r?.image
                ? <img src={r.image} alt={`Branded image ${i + 1}`} className={`w-full ${waiting ? 'opacity-60' : ''}`} style={{ aspectRatio: `${r.width} / ${r.height}` }} />
                : <div className="flex aspect-square w-full items-center justify-center p-3 text-center text-xs text-muted">{f?.error || r?.error ? (f?.error || r.error) : 'Finding your product…'}</div>}
              <figcaption className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white">{i === 0 ? 'Cover' : `Image ${i + 1}`}</figcaption>
              {r?.image && <a href={r.image} download={`image-${i + 1}-${options.format}.jpg`} className="absolute right-2 bottom-2 rounded-full bg-white/90 px-2.5 py-1 text-[11px] font-bold text-ink no-underline">Download</a>}
            </figure>
          )
        })}
      </div>
      {waiting && <p role="status" className="text-xs font-semibold text-muted">{missing.length ? `Finding the product in ${missing.length} ${missing.length === 1 ? 'photo' : 'photos'}…` : 'Updating…'}</p>}

      <div className="flex gap-2">
        <button onClick={() => set({ logo: !options.logo })} aria-pressed={options.logo} className={toggle(options.logo)}>Logo {options.logo ? 'on' : 'off'}</button>
        <button onClick={() => set({ badge: !options.badge })} aria-pressed={options.badge} disabled={!price} className={`${toggle(options.badge && !!price)} disabled:opacity-50`}>Price badge {options.badge && price ? 'on' : 'off'}</button>
      </div>
      {sources.length > 1 && (
        <button onClick={() => set({ badgeAll: !options.badgeAll })} aria-pressed={options.badgeAll} disabled={!price || !options.badge} className={`${toggle(options.badgeAll)} disabled:opacity-50`}>
          Price badge on {options.badgeAll ? 'all images' : 'the cover only'}
        </button>
      )}
      <div className="flex gap-2">
        <div role="radiogroup" aria-label="Format" className="grid flex-1 grid-cols-2 gap-1 rounded-btn bg-track p-1">
          {[['square', 'Square'], ['portrait', 'Portrait']].map(([id, label]) => (
            <button key={id} role="radio" aria-checked={options.format === id} onClick={() => set({ format: id, region: 0 })}
              className={`min-h-11 rounded-[10px] text-sm font-semibold ${options.format === id ? 'bg-white text-accent-dark shadow-sm' : 'text-muted'}`}>{label}</button>
          ))}
        </div>
        <button onClick={() => set({ region: options.region + 1 })} disabled={!options.logo || regions < 2}
          className="min-h-11 rounded-btn border border-line bg-white px-3 text-sm font-bold disabled:opacity-50">Move logo</button>
      </div>
      {notes.length > 0 && <ul className="flex flex-col gap-1 rounded-btn bg-amber-soft px-3 py-2 text-xs text-amber-ink">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {error && <p role="alert" className="text-xs text-warn">{error}</p>}
      <div className="flex gap-2">
        <button onClick={downloadAll} disabled={!rendered.length || waiting} className="min-h-11 flex-1 rounded-btn border border-line bg-white text-sm font-bold disabled:opacity-50">
          {rendered.length > 1 ? 'Download all (zip)' : 'Download image'}
        </button>
        {draftId && !demo && <button onClick={keep} disabled={!ready.length || waiting} className="min-h-11 flex-1 rounded-btn bg-accent px-3 text-sm font-bold text-white disabled:opacity-50">{saved ? 'Kept with the draft' : 'Keep with this draft'}</button>}
      </div>
      <p className="text-[11px] text-muted">
        The logo is in the best empty space of each image{Object.values(shown.items).find((r) => r?.logo) ? `, for example ${REGION[Object.values(shown.items).find((r) => r?.logo).logo.region]} on one of them` : ''}.
        Product found as {[...new Set(ready.map((s) => `“${found[s.id].phrase}”`))].join(', ') || '…'}. The product itself is never changed.
      </p>
    </section>
  )
}
