import { useState } from 'react'
import { post } from '../api'
import { importLocal } from '../stockLocal'
import { ErrorState, Skeleton } from './ui'

const FIELDS = [['name', 'Product name'], ['size', 'Size'], ['color', 'Color'], ['quantity', 'Quantity in stock'], ['price', 'Price'], ['sku', 'Code / SKU']]
const input = 'min-h-11 rounded-btn border border-line bg-white px-3 text-[15px] font-normal text-ink'

const toBase64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

// How sure we are about a match, in words the owner can act on.
const LEVEL = {
  high: ['Same product', 'bg-accent-soft text-accent-dark'],
  likely: ['Probably the same', 'bg-info-soft text-info'],
  ask: ['Not sure: please check', 'bg-amber-soft text-amber-ink'],
}

function Group({ g, choice, onChoose }) {
  const level = g.match ? LEVEL[g.match.level] : null
  const unresolved = g.match?.level === 'ask' && !choice
  return (
    <li className={`flex flex-col gap-2 rounded-card border bg-white p-3 ${unresolved ? 'border-amber-line' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[15px] font-bold">{g.name}</p>
        {level ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${level[1]}`}>{level[0]} {Math.round(g.match.confidence * 100)}%</span>
          : <span className="shrink-0 rounded-full bg-track px-2 py-0.5 text-[11px] font-bold text-muted">Not in your catalog</span>}
      </div>
      <p className="text-xs text-muted">
        {g.variants.map((v) => `${[v.size, v.color].filter(Boolean).join(' ') || 'all'}: ${v.quantity}`).join(' · ')}
        {g.also?.length > 0 && ` · also written as ${g.also.map((a) => `"${a}"`).join(', ')}`}
      </p>
      {g.match && g.current?.length > 0 && <p className="text-xs text-muted">Now in stock: {g.current.map((v) => `${[v.size, v.color].filter(Boolean).join(' ') || 'all'}: ${v.quantity}`).join(' · ')}</p>}
      <select value={choice ?? ''} onChange={(e) => onChoose(e.target.value)} aria-label={`What to do with ${g.name}`} className={input}>
        {unresolved && <option value="">Choose…</option>}
        {g.match && <option value={`update:${g.match.product_id}`}>Update “{g.match.name}”</option>}
        {g.candidates.filter((c) => c.id !== g.match?.product_id).map((c) => <option key={c.id} value={`update:${c.id}`}>Update “{c.name}” instead</option>)}
        <option value="create">Add as a new product</option>
        <option value="skip">Skip it</option>
      </select>
    </li>
  )
}

// Import stock from the owner's own sheet: read it, check the columns, check the matches, then confirm. Nothing is
// saved before the last button. The demo applies the result in this tab only.
export function StockImport({ session, onClose, onDone }) {
  const demo = session.demo
  const pageId = session.page.id
  const [file, setFile] = useState(null) // { base64, name }
  const [preview, setPreview] = useState(null)
  const [mapping, setMapping] = useState(null)
  const [choices, setChoices] = useState({})
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  const load = async (f, { sheet, map } = {}) => {
    setBusy('reading'); setError(null)
    try {
      const p = await post(`/pages/${pageId}/stock/preview`, { accessToken: session.token, file: f.base64, sheet, ...(map && { mapping: map }) })
      setPreview(p); setMapping(p.mapping)
      setChoices(Object.fromEntries(p.groups.filter((g) => g.match && g.match.level !== 'ask').map((g) => [g.key, `update:${g.match.product_id}`]).concat(p.groups.filter((g) => !g.match).map((g) => [g.key, 'create']))))
    } catch (e) { setError(e.message) }
    setBusy(null)
  }
  const choose = async (picked) => {
    if (!picked) return
    setError(null)
    if (picked.size > 5 * 1024 * 1024) { setError('The file must be 5 MB or smaller.'); return }
    const f = { base64: await toBase64(picked), name: picked.name }
    setFile(f); load(f)
  }
  const sample = async () => {
    const res = await fetch('/sample-stock.xlsx')
    if (!res.ok) { setError('The sample file could not be loaded.'); return }
    choose(new File([await res.blob()], 'sample-stock.xlsx'))
  }

  const decided = (preview?.groups ?? []).filter((g) => choices[g.key])
  const open = (preview?.groups ?? []).length - decided.length
  const toImport = decided.filter((g) => choices[g.key] !== 'skip')

  const confirm = async () => {
    setBusy('importing'); setError(null)
    const groups = decided.map((g) => {
      const c = choices[g.key]
      return { key: g.key, name: g.name, action: c === 'skip' ? 'skip' : c === 'create' ? 'create' : 'update', product_id: c.startsWith('update:') ? c.slice(7) : undefined, variants: g.variants }
    })
    try {
      const result = demo ? importLocal(groups, preview.layout) : await post(`/pages/${pageId}/stock/import`, { accessToken: session.token, groups, layout: preview.layout })
      setDone(result); onDone()
    } catch (e) { setError(e.message) }
    setBusy(null)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Import stock" className="fixed inset-0 z-30 overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-svh max-w-[430px] flex-col gap-4 px-5 pt-5 pb-16">
        <button onClick={onClose} className="flex min-h-11 items-center self-start rounded-btn px-2 text-sm font-semibold text-info">← Back to catalog</button>
        <h1 className="text-[22px] font-bold">Import stock from Excel</h1>

        {done ? (
          <>
            <div role="status" className="flex flex-col gap-1 rounded-card bg-accent-soft p-4 text-sm text-accent-dark">
              <strong>Done.</strong>
              <span>{done.updated} products updated, {done.created} added, {done.variants} stock lines saved{done.skipped ? `, ${done.skipped} skipped` : ''}.</span>
              {done.sold_out.length > 0 && <span>Now sold out (stock is 0): {done.sold_out.join(', ')}. Open them in the catalog to write caption updates for their posts.</span>}
              {done.restocked.length > 0 && <span>Back in stock: {done.restocked.join(', ')}.</span>}
              {demo && <span>Demo mode: this stays in your browser tab.</span>}
            </div>
            <button onClick={onClose} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white">Back to the catalog</button>
          </>
        ) : (
          <>
            {!preview && (
              <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
                <p className="text-sm text-muted">Choose your stock sheet (.xlsx or .csv, up to 5 MB). Column names can be in Bangla, Banglish or English. Nothing is saved until you confirm.</p>
                <label htmlFor="stock-file" className="flex min-h-12 cursor-pointer items-center justify-center rounded-btn border-2 border-dashed border-accent-pale bg-accent-soft px-4 text-[15px] font-bold text-accent-dark">Choose a file</label>
                <input id="stock-file" type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={(e) => choose(e.target.files[0])} />
                {demo && <button onClick={sample} className="min-h-11 text-sm font-semibold text-info underline">Or try the sample file (Banglish headers)</button>}
              </section>
            )}

            {busy === 'reading' && <div role="status" className="flex flex-col gap-2"><p className="text-sm text-muted">Reading your sheet and matching your products. This takes a few seconds.</p><Skeleton className="h-32" /></div>}
            {error && <ErrorState message={error} onRetry={file ? () => load(file) : undefined} />}

            {preview && busy !== 'reading' && (
              <>
                <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-4">
                  <h2 className="text-[15px] font-bold">1. Are the columns right?</h2>
                  <p className="text-xs text-muted">{file?.name}{preview.sheets.length > 1 && ' · '}
                    {preview.sheets.length > 1 && (
                      <select value={preview.sheet} onChange={(e) => load(file, { sheet: e.target.value })} aria-label="Sheet" className="rounded-btn border border-line bg-white px-2 py-1 text-xs">
                        {preview.sheets.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    )}
                  </p>
                  {FIELDS.map(([f, label]) => (
                    <label key={f} className="flex flex-col gap-1 text-xs font-semibold text-muted">{label}{(f === 'name' || f === 'quantity') && <span className="text-warn"> (needed)</span>}
                      <select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value === '' ? null : Number(e.target.value) })} className={input}>
                        <option value="">(not in my sheet)</option>
                        {preview.header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1} (no heading)`}{preview.sample[0]?.[i] !== undefined && preview.sample[0][i] !== '' ? ` — e.g. ${String(preview.sample[0][i]).slice(0, 22)}` : ''}</option>)}
                      </select>
                    </label>
                  ))}
                  {preview.notes && <p className="text-xs text-muted">Note: {preview.notes}</p>}
                  <button onClick={() => load(file, { sheet: preview.sheet, map: mapping })} disabled={busy !== null || mapping.name == null || mapping.quantity == null} className="min-h-11 rounded-btn border border-line bg-white px-4 text-sm font-bold disabled:opacity-50">Update the preview</button>
                </section>

                {preview.needs_mapping ? (
                  <p role="alert" className="rounded-card bg-amber-soft px-4 py-3 text-sm text-amber-ink">We could not tell which columns hold the product name and the quantity. Choose them above, then update the preview.</p>
                ) : (
                  <>
                    <section className="flex flex-col gap-2.5">
                      <h2 className="text-[15px] font-bold">2. What will be imported</h2>
                      <p className="text-sm text-muted">{preview.totals.products} products: {preview.totals.matched} matched, {preview.totals.to_confirm} to check, {preview.totals.new} new. Nothing is saved yet.</p>
                      <ul className="flex flex-col gap-2.5">{preview.groups.map((g) => <Group key={g.key} g={g} choice={choices[g.key]} onChoose={(v) => setChoices({ ...choices, [g.key]: v })} />)}</ul>
                    </section>
                    {(preview.problems.length > 0 || preview.ignored.length > 0) && (
                      <details className="rounded-card border border-line bg-white px-4 py-3 text-sm" open={preview.problems.length > 0}>
                        <summary className="min-h-9 cursor-pointer font-bold">Rows left out ({preview.problems.length + preview.ignored.length})</summary>
                        <ul className="flex flex-col gap-1 pb-1 text-xs">
                          {preview.problems.map((p, i) => <li key={`p${i}`} className="text-warn">Row {p.row} “{p.name}”: {p.message}</li>)}
                          {preview.ignored.map((p, i) => <li key={`i${i}`} className="text-muted">Row {p.row}: skipped, {p.reason}</li>)}
                        </ul>
                      </details>
                    )}
                    <button onClick={confirm} disabled={busy !== null || open > 0 || toImport.length === 0} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
                      {busy === 'importing' ? 'Importing…' : open > 0 ? `Check ${open} more ${open === 1 ? 'product' : 'products'} first` : `Import ${toImport.length} ${toImport.length === 1 ? 'product' : 'products'}`}
                    </button>
                    {demo && <p className="text-xs text-muted">Demo mode: the import stays in this browser tab.</p>}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
