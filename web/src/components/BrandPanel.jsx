import { useEffect, useState } from 'react'
import { API_URL, getAuth, post, request } from '../api'
import { localBrand, setLocalBrand } from '../brandLocal'
import { ErrorState, Skeleton } from './ui'

const input = 'min-h-11 rounded-btn border border-line bg-white px-3 text-[15px] font-normal text-ink'
const checker = 'bg-[length:16px_16px] bg-[linear-gradient(45deg,#e5e7eb_25%,transparent_25%,transparent_75%,#e5e7eb_75%),linear-gradient(45deg,#e5e7eb_25%,transparent_25%,transparent_75%,#e5e7eb_75%)] bg-[position:0_0,8px_8px]'

// Shop name, brand color and logo. A logo is uploaded (PNG or SVG) or generated: three options, each read back to be
// sure it spells the shop name. The demo keeps all of this in the tab.
export function BrandPanel({ session, onClose }) {
  const demo = session.demo
  const pageId = session.page.id
  const [brand, setBrand] = useState(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#12694A')
  const [pending, setPending] = useState(null) // a logo chosen or uploaded, not yet saved
  const [options, setOptions] = useState(null)
  const [style, setStyle] = useState('wordmark')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    let cancelled = false
    const done = (b) => { if (!cancelled) { setBrand(b); setName(b.shop_name ?? ''); setColor(b.color ?? '#12694A') } }
    if (demo) Promise.resolve(localBrand()).then((b) => done({ ...b, logo_url: b.logo, has_logo: !!b.logo }))
    else getAuth(`/pages/${pageId}/brand`, session.token).then(done).catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, demo, session.token])

  const guarded = async (key, fn) => {
    setBusy(key); setError(null); setNotice(null)
    try { await fn() } catch (e) { setError(e.message) }
    setBusy(null)
  }
  const token = { accessToken: session.token }

  const upload = (file) => guarded('upload', async () => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) throw new Error('The logo must be 2 MB or smaller.')
    const res = await fetch(`${API_URL}/pages/${pageId}/brand/logo/process`, { method: 'POST', headers: { 'Content-Type': file.type || 'image/png', 'x-access-token': session.token ?? '' }, body: file })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Upload failed (HTTP ${res.status})`)
    setPending(body.image); setOptions(null)
  })

  const generate = () => guarded('generate', async () => {
    const r = await post(`/pages/${pageId}/brand/logo/generate`, { style, shop_name: name, color, ...token })
    setOptions(r.options); setPending(null)
  })

  const save = () => guarded('save', async () => {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('Type the shop name.')
    if (demo) setBrand((b) => ({ ...b, ...setLocalBrand({ shop_name: cleanName, color, ...(pending && { logo: pending }) }), has_logo: !!(pending || b.logo), logo_url: pending || b.logo_url }))
    else {
      let next = await request(`/pages/${pageId}/brand`, { shop_name: cleanName, color, ...token }, 'PUT')
      if (pending) next = await post(`/pages/${pageId}/brand/logo/save`, { image: pending, ...token })
      setBrand(next)
    }
    setPending(null); setOptions(null)
    setNotice('Saved. Your photos will use this logo.')
  })

  return (
    <div role="dialog" aria-modal="true" aria-label="Brand settings" className="fixed inset-0 z-40 overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-svh max-w-[430px] flex-col gap-4 px-5 pt-5 pb-16">
        <button onClick={onClose} className="flex min-h-11 items-center self-start rounded-btn px-2 text-sm font-semibold text-info">← Close</button>
        <h1 className="text-[22px] font-bold">Brand settings</h1>
        <p className="text-sm text-muted">Your logo goes on your product photos, in empty space only. Your product is never changed.{demo && ' Demo mode: this stays in your browser tab.'}</p>
        {!brand && !error && <Skeleton className="h-40" />}
        {error && <ErrorState message={error} />}
        {notice && <p role="status" className="rounded-card bg-accent-soft px-4 py-3 text-sm font-semibold text-accent-dark">{notice}</p>}

        {brand && (
          <>
            <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
              <label className="flex flex-col gap-1 text-xs font-semibold text-muted">Shop name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className={input} />
              </label>
              <label className="flex items-center gap-3 text-xs font-semibold text-muted">Brand color
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Brand color" className="size-11 cursor-pointer rounded-btn border border-line bg-white p-1" />
                <span className="text-sm font-normal text-ink">{color}</span>
              </label>
            </section>

            <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
              <h2 className="text-[15px] font-bold">Logo</h2>
              <div className={`flex min-h-24 items-center justify-center rounded-btn border border-line p-3 ${checker}`}>
                {pending || brand.logo_url
                  ? <img src={pending || brand.logo_url} alt="Your logo" className="max-h-24 max-w-full object-contain" />
                  : <span className="rounded bg-white/90 px-2 py-1 text-sm text-muted">No logo yet</span>}
              </div>
              {pending && <p className="text-xs font-semibold text-accent-dark">New logo chosen. Press Save to use it.</p>}
              <label htmlFor="logo-file" className="flex min-h-11 cursor-pointer items-center justify-center rounded-btn border border-line bg-white px-3 text-sm font-bold">
                {busy === 'upload' ? 'Reading…' : 'Upload a logo (PNG or SVG)'}
              </label>
              <input id="logo-file" type="file" accept="image/png,image/svg+xml,.png,.svg" className="sr-only" onChange={(e) => { upload(e.target.files[0]); e.target.value = '' }} />
              <p className="text-xs text-muted">A transparent background is best. A logo on a plain white box has the white removed.</p>
            </section>

            <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
              <h2 className="text-[15px] font-bold">No logo? Make one</h2>
              <div role="radiogroup" aria-label="Logo style" className="grid grid-cols-2 gap-1 rounded-btn bg-track p-1">
                {[['wordmark', 'Simple wordmark'], ['icon', 'Icon + name']].map(([id, label]) => (
                  <button key={id} role="radio" aria-checked={style === id} onClick={() => setStyle(id)}
                    className={`min-h-11 rounded-[10px] text-sm font-semibold ${style === id ? 'bg-white text-accent-dark shadow-sm' : 'text-muted'}`}>{label}</button>
                ))}
              </div>
              <button onClick={generate} disabled={busy !== null || !name.trim()} className="min-h-12 rounded-btn bg-accent px-4 text-[15px] font-bold text-white disabled:opacity-50">
                {busy === 'generate' ? 'Designing 3 logos… about 30 seconds' : 'Generate a logo'}
              </button>
              {options && (
                <ul className="grid grid-cols-1 gap-2.5" aria-label="Logo options">
                  {options.map((o, i) => (
                    <li key={o.id}>
                      <button onClick={() => setPending(o.image)} aria-pressed={pending === o.image}
                        className={`flex w-full flex-col items-center gap-1.5 rounded-card border p-3 ${pending === o.image ? 'border-accent ring-2 ring-accent-pale' : 'border-line'} ${checker}`}>
                        <img src={o.image} alt={`Logo option ${i + 1}`} className="max-h-20 max-w-full object-contain" />
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${o.verified ? 'bg-accent-soft text-accent-dark' : 'bg-amber-soft text-amber-ink'}`}>
                          {o.verified ? 'Spelling checked' : `Check the spelling (read as “${o.read ?? '?'}”)`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <button onClick={save} disabled={busy !== null} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
