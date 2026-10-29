import { useRef, useState } from 'react'
import { API_URL, post } from '../api'
import { saveDemoDraft } from '../drafts'
import { MAX_PHOTO_MB, MAX_PHOTOS, blobToDataUrl, shrink } from '../photoTools'
import { Card, LanguageToggle, PostEditor } from '../components/PostEditor'
import { ErrorState, Skeleton } from '../components/ui'

const ISSUE = {
  blurry: 'Blurry', too_dark: 'Too dark', too_bright: 'Too bright', cluttered_background: 'Busy background',
  product_cut_off: 'Product is cut off', product_too_small: 'Product looks small in the photo', glare: 'Glare',
  low_resolution: 'Low resolution', other: 'Other problem',
}
const EMPTY_FORM = { name: '', price: '', sizes: '', colors: '', stock: '', offer: '' }

function Field({ label, hint, guess, required, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
      <span>
        {label}{required && <span className="text-warn"> *</span>}
        {guess && <span className="ml-1.5 rounded-full bg-amber-soft px-1.5 py-0.5 text-[10px] text-amber-ink">AI guess: check it</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] font-normal">{hint}</span>}
    </label>
  )
}
const inputClass = 'min-h-11 rounded-btn border border-line px-3 text-[15px] font-normal text-ink'

// "I have a new product": photos -> what we see + tips -> a short form -> caption -> save.
export function CreateNew({ session }) {
  const pageId = session.page.id
  const picker = useRef(null)
  const [photos, setPhotos] = useState([]) // { id, previewUrl, status: preparing | ready | error, uploadId | data, error }
  const [analysis, setAnalysis] = useState(null)
  const [tips, setTips] = useState([])
  const [form, setForm] = useState(EMPTY_FORM)
  const [guessed, setGuessed] = useState({}) // fields prefilled by the AI and not edited yet
  const [language, setLanguage] = useState('banglish')
  const [result, setResult] = useState(null)
  const [resultKey, setResultKey] = useState(0)
  const [caption, setCaption] = useState('')
  const [saved, setSaved] = useState(null)
  const [busy, setBusy] = useState(null) // analysing | generating | saving
  const [error, setError] = useState(null)

  const ready = photos.filter((p) => p.status === 'ready')
  const stale = () => { setAnalysis(null); setTips([]); setResult(null); setSaved(null) } // photos changed: start the analysis over
  const update = (id, patch) => setPhotos((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const setField = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setGuessed((g) => ({ ...g, [key]: false })) }

  const prepare = async (entry, file) => {
    try {
      const { blob } = await shrink(file)
      if (session.demo) { update(entry.id, { status: 'ready', data: await blobToDataUrl(blob) }); return } // demo: stays in this tab
      const res = await fetch(`${API_URL}/pages/${pageId}/uploads`, {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-access-token': session.token }, body: blob,
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `Upload failed (HTTP ${res.status})`)
      update(entry.id, { status: 'ready', uploadId: body.id })
    } catch (e) { update(entry.id, { status: 'error', error: e.message }) }
  }

  const addFiles = (fileList) => {
    setError(null)
    const room = MAX_PHOTOS - photos.length
    const files = [...fileList]
    if (files.length > room) setError(`You can add up to ${MAX_PHOTOS} photos. The extra ones were left out.`)
    for (const file of files.slice(0, Math.max(room, 0))) {
      if (!file.type.startsWith('image/')) { setError(`"${file.name}" is not a photo.`); continue }
      if (file.size > MAX_PHOTO_MB * 1024 * 1024) { setError(`"${file.name}" is bigger than ${MAX_PHOTO_MB} MB.`); continue }
      const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, previewUrl: URL.createObjectURL(file), status: 'preparing' }
      setPhotos((list) => [...list, entry])
      stale()
      prepare(entry, file)
    }
    if (picker.current) picker.current.value = '' // the same photo can be picked again
  }
  const removePhoto = (id) => { setPhotos((list) => list.filter((p) => p.id !== id)); stale() }

  const analyse = async () => {
    setBusy('analysing'); setError(null)
    try {
      const r = await post(`/pages/${pageId}/products/analyze`, {
        accessToken: session.token,
        images: ready.map((p) => (session.demo ? { data: p.data } : { upload_id: p.uploadId })),
      })
      setAnalysis(r.analysis); setTips(r.tips)
      // prefill what is still empty; edits the owner already made are kept
      const colors = r.analysis.colors.filter((c) => c.confidence !== 'low').map((c) => c.name).join(', ')
      setForm((f) => ({ ...f, name: f.name || r.analysis.suggested_name, colors: f.colors || colors }))
      setGuessed((g) => ({ ...g, name: !form.name, colors: !form.colors && !!colors }))
    } catch (e) { setError(e.message) }
    setBusy(null)
  }

  const priceOk = /\d/.test(form.price)
  const generate = async (lang = language) => {
    setBusy('generating'); setError(null)
    try {
      const r = await post(`/pages/${pageId}/posts/generate`, { accessToken: session.token, language: lang, newProduct: { form, analysis } })
      setResult({ ...r, photo_url: photos[0]?.previewUrl }); setCaption(r.caption); setResultKey((k) => k + 1); setSaved(null)
    } catch (e) { setError(e.message) }
    setBusy(null)
  }
  const pickLanguage = (lang) => {
    if (lang === language) return
    setLanguage(lang)
    if (result) generate(lang) // switching regenerates
  }

  const save = async () => {
    setBusy('saving'); setError(null)
    try {
      if (session.demo) {
        const small = await shrink(await (await fetch(ready[0].data)).blob(), 240, 0.7)
        saveDemoDraft({ ...result, caption, photo_url: await blobToDataUrl(small.blob) })
        setSaved({ demo: true })
      } else {
        const r = await post(`/pages/${pageId}/products`, {
          accessToken: session.token, form, analysis, upload_ids: ready.map((p) => p.uploadId),
          draft: { caption, language: result.language, why: result.why, patterns_used: result.patterns_used, placeholders: result.placeholders },
        })
        setSaved({ product: r.product })
      }
    } catch (e) { setError(e.message) }
    setBusy(null)
  }

  const working = busy !== null || photos.some((p) => p.status === 'preparing')
  const problems = analysis?.photos.flatMap((p) => p.quality_issues.map((q) => ({ ...q, photo: p.index + 1 }))) ?? []

  return (
    <>
      <Card title="1. Photos of your new product">
        <p className="text-sm text-muted">Add 1 to {MAX_PHOTOS} photos (up to {MAX_PHOTO_MB} MB each). Take one now or pick from your gallery. Location data is removed.</p>
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-2" aria-label="Your photos">
            {photos.map((p, i) => (
              <li key={p.id} className="relative">
                <img src={p.previewUrl} alt={`Photo ${i + 1}`} className={`aspect-square w-full rounded-btn bg-track object-cover ${p.status !== 'ready' ? 'opacity-50' : ''}`} />
                {p.status === 'preparing' && <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold">Uploading…</span>}
                {p.status === 'error' && <span role="alert" className="absolute inset-x-0 bottom-0 rounded-b-btn bg-warn-soft p-1 text-[10px] text-warn">{p.error}</span>}
                <button onClick={() => removePhoto(p.id)} aria-label={`Remove photo ${i + 1}`}
                  className="absolute -top-2 -right-2 flex size-7 items-center justify-center rounded-full bg-ink text-sm font-bold text-white">×</button>
              </li>
            ))}
          </ul>
        )}
        <input ref={picker} type="file" accept="image/*" multiple className="sr-only" id="photo-input" onChange={(e) => addFiles(e.target.files)} />
        {photos.length < MAX_PHOTOS && (
          <label htmlFor="photo-input" className="flex min-h-12 cursor-pointer items-center justify-center rounded-btn border-2 border-dashed border-accent-pale bg-accent-soft px-4 text-[15px] font-bold text-accent-dark">
            {photos.length ? 'Add another photo' : 'Add photos'}
          </label>
        )}
        {!analysis && (
          <button onClick={analyse} disabled={!ready.length || working}
            className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
            {busy === 'analysing' ? 'Looking at your photos…' : 'Look at my photos'}
          </button>
        )}
      </Card>

      {busy === 'analysing' && <div role="status"><Skeleton className="h-32" /></div>}

      {analysis && (
        <>
          <Card title="What we see">
            <p className="text-[15px] font-semibold first-letter:uppercase">{analysis.product_phrase}</p>
            <ul className="flex flex-wrap gap-1.5 text-xs">
              {analysis.colors.map((c) => (
                <li key={c.name} className="rounded-full bg-track px-2.5 py-1 font-semibold capitalize">{c.name}{c.confidence === 'low' && ' (not sure)'}</li>
              ))}
              {analysis.style && <li className="rounded-full bg-track px-2.5 py-1 font-semibold">{analysis.style}</li>}
            </ul>
            <ul className="flex flex-col gap-1 text-sm text-muted">
              {analysis.photos.map((p) => (
                <li key={p.index}>Photo {p.index + 1}: {p.worn_or_flat === 'unknown' ? 'style unclear' : p.worn_or_flat}, {p.background_style} background</li>
              ))}
            </ul>
            {analysis.guesses.length > 0 && (
              <p className="text-sm text-muted">
                We can't tell for sure, but it might be: {analysis.guesses.map((g) => `${g.field}: ${g.value}`).join('; ')}. Check these yourself.
              </p>
            )}
            {problems.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-btn bg-amber-soft px-3 py-2.5 text-sm text-amber-ink">
                {problems.map((q, i) => <li key={i}><strong>Photo {q.photo}: {ISSUE[q.issue] ?? q.issue}.</strong> {q.detail}</li>)}
              </ul>
            )}
          </Card>

          <Card title="Photo tips from your playbook">
            {tips.length === 0
              ? <p className="text-sm text-muted">Nothing to change. Your playbook has no photo style that clearly beats this one.</p>
              : (
                <ul className="flex flex-col gap-2.5 text-sm">
                  {tips.map((t) => <li key={t.dimension} className="border-l-2 border-accent-pale pl-3">{t.text}</li>)}
                </ul>
              )}
          </Card>

          <Card title="2. Details">
            <p className="text-sm text-muted">Only the price is needed. Anything you leave empty becomes a [PLACEHOLDER] in the caption.</p>
            <Field label="Product name" guess={guessed.name}>
              <input value={form.name} onChange={(e) => setField('name', e.target.value)} maxLength={80} className={inputClass} />
            </Field>
            <Field label="Price (Tk)" required>
              <input value={form.price} onChange={(e) => setField('price', e.target.value)} inputMode="decimal" placeholder="for example 950" className={`${inputClass} border-accent`} />
            </Field>
            <Field label="Sizes" hint="Separate with commas, for example 38, 39, 40 or S, M, L">
              <input value={form.sizes} onChange={(e) => setField('sizes', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Colors" guess={guessed.colors}>
              <input value={form.colors} onChange={(e) => setField('colors', e.target.value)} className={inputClass} />
            </Field>
            <Field label="Stock (how many)">
              <input value={form.stock} onChange={(e) => setField('stock', e.target.value)} inputMode="numeric" className={inputClass} />
            </Field>
            <Field label="Offer" hint="for example 10% off this week">
              <input value={form.offer} onChange={(e) => setField('offer', e.target.value)} maxLength={100} className={inputClass} />
            </Field>
          </Card>

          <LanguageToggle language={language} onChange={pickLanguage} disabled={busy !== null} />
          {!result && (
            <button onClick={() => generate()} disabled={!priceOk || working}
              className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
              {busy === 'generating' ? 'Writing…' : 'Write my post'}
            </button>
          )}
        </>
      )}

      {busy === 'generating' && (
        <div role="status" className="flex flex-col gap-2.5">
          <p className="text-sm text-muted">Writing your post. This can take up to 30 seconds.</p>
          <Skeleton className="h-40" />
        </div>
      )}
      {error && <ErrorState message={error} onRetry={analysis ? undefined : ready.length ? analyse : undefined} />}

      {result && busy !== 'generating' && (
        <PostEditor key={resultKey} result={result} photo={photos[0]?.previewUrl} onCaption={setCaption} onRegenerate={() => generate()}
          saveSlot={saved ? (
            <p role="status" className="rounded-card bg-accent-soft px-4 py-3 text-sm font-semibold text-accent-dark">
              {saved.demo ? 'Saved in this browser tab (demo mode). Find it under Your drafts on Home.' : 'Saved. The product is in your catalog and the draft is on Home.'}
            </p>
          ) : (
            <button onClick={save} disabled={busy !== null} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
              {busy === 'saving' ? 'Saving…' : 'Save product and draft'}
            </button>
          )}
          note={session.demo ? 'Demo mode: photos and drafts stay in this browser tab only and are never stored.' : 'Photos are kept privately in your account, without location data.'} />
      )}
    </>
  )
}
