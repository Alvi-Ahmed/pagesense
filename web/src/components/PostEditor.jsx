import { useState } from 'react'

const LANGUAGES = [['bangla', 'বাংলা'], ['english', 'English'], ['banglish', 'Banglish']]
const LABEL = { PRICE: 'Price', SIZES: 'Sizes', COLORS: 'Colors', 'DELIVERY CHARGE': 'Delivery charge', STOCK: 'Stock count' }
const PLACEHOLDER = /\[(PRICE|SIZES|COLORS|DELIVERY CHARGE|STOCK)\]/g

const fillIn = (text, values) => text.replace(PLACEHOLDER, (m, key) => values[key]?.trim() || m)
const placeholdersIn = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]
const chip = (pattern) => (pattern ? `${pattern.pattern}: ${pattern.value}` : 'Playbook tip')

export function Card({ title, children }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-white px-4 py-4">
      {title && <h2 className="text-[15px] font-bold">{title}</h2>}
      {children}
    </section>
  )
}

export function LanguageToggle({ language, onChange, disabled }) {
  return (
    <div role="radiogroup" aria-label="Language" className="grid grid-cols-3 gap-1 rounded-btn bg-track p-1">
      {LANGUAGES.map(([id, label]) => (
        <button key={id} role="radio" aria-checked={language === id} disabled={disabled} onClick={() => onChange(id)}
          className={`min-h-11 rounded-[10px] text-sm font-semibold disabled:opacity-60 ${language === id ? 'bg-white text-accent-dark shadow-sm' : 'text-muted'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

// The caption as the owner will see it: unfilled facts glow amber, filled ones are bold.
function Preview({ template, values }) {
  const parts = template.split(PLACEHOLDER) // text, key, text, key, ...
  return (
    <p className="whitespace-pre-wrap rounded-card bg-white px-4 py-3.5 text-[15px] leading-relaxed">
      {parts.map((part, i) => {
        if (i % 2 === 0) return part
        const value = values[part]?.trim()
        return value
          ? <strong key={i} className="text-accent-dark">{value}</strong>
          : <mark key={i} className="rounded-md bg-amber-soft px-1 font-bold text-amber-ink outline outline-1 outline-amber-line">[{part}]</mark>
      })}
    </p>
  )
}

// Caption box with placeholder fields, a live preview, the reasons, and the copy / regenerate / coming-soon buttons.
// Remount it (key) for every new result: it keeps the owner's edits and filled-in values while the result stays the same.
export function PostEditor({ result, photo, onCaption, onSaveEdit, onRegenerate, note, saveSlot }) {
  const [template, setTemplate] = useState(result.caption)
  const [values, setValues] = useState({})
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)

  const open = placeholdersIn(fillIn(template, values))
  const edit = (text) => { setTemplate(text); setCopied(false); onCaption?.(text) }
  const copy = async () => {
    try { await navigator.clipboard.writeText(fillIn(template, values)); setCopied(true); setError(null) }
    catch { setError('Could not copy. Select the text in the box and copy it by hand.') }
  }

  return (
    <>
      {photo && <img src={photo} alt="Photo for this post" className="aspect-square w-full rounded-card bg-track object-cover" />}

      <Card title="Your caption">
        <textarea value={template} onChange={(e) => edit(e.target.value)} onBlur={() => onSaveEdit?.(template)}
          rows={10} aria-label="Caption" className="rounded-btn border border-line px-3 py-2.5 text-[15px] leading-relaxed" />
        {placeholdersIn(template).length > 0 && (
          <div className="flex flex-col gap-2.5">
            <p className="text-sm font-semibold">Fill in what we don't know</p>
            {placeholdersIn(template).map((key) => (
              <label key={key} className="flex flex-col gap-1 text-xs font-semibold text-muted">
                {LABEL[key]}
                <input value={values[key] ?? ''} onChange={(e) => { setValues({ ...values, [key]: e.target.value }); setCopied(false) }}
                  placeholder={`[${key}]`} className="min-h-11 rounded-btn border border-amber-line bg-amber-soft px-3 text-[15px] font-normal text-ink" />
              </label>
            ))}
          </div>
        )}
        <p className="text-xs font-semibold text-muted">How it will look</p>
        <Preview template={template} values={values} />
        {open.length > 0 && <p className="text-xs text-warn">Still to fill in: {open.map((k) => LABEL[k]).join(', ')}.</p>}
      </Card>

      {result.kind === 'improve' ? (
        <Card title="What changed and why">
          <ul className="flex flex-col gap-3 text-sm">
            {result.changes.map((c, i) => (
              <li key={i} className="flex flex-col gap-1">
                <span className="self-start rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-dark">{chip(c.pattern)}</span>
                <span><strong>{c.change}.</strong> {c.reason}</span>
              </li>
            ))}
          </ul>
          {result.original_caption && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer font-semibold leading-[44px] text-info">See the original</summary>
              <p className="whitespace-pre-wrap rounded-btn bg-track px-3 py-2.5 text-muted">{result.original_caption}</p>
            </details>
          )}
        </Card>
      ) : (
        <Card title="Why this works">
          <ul className="flex flex-col gap-3 text-sm">
            {result.why.map((w, i) => (
              <li key={i} className="flex flex-col gap-1">
                <span className="self-start rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-dark">{chip(w.pattern)}</span>
                <span>{w.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex flex-col gap-2.5">
        {saveSlot}
        <button onClick={copy} className={`min-h-12 rounded-btn px-5 text-[15px] font-bold ${saveSlot ? 'border border-line bg-white' : 'bg-accent text-white'}`}>
          {copied ? 'Copied!' : 'Copy caption'}
        </button>
        <button onClick={onRegenerate} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">Regenerate</button>
        <div className="grid grid-cols-2 gap-2.5">
          <button disabled className="min-h-12 rounded-btn border border-line bg-track px-3 text-sm font-semibold text-muted opacity-70">Schedule</button>
          <button disabled className="min-h-12 rounded-btn border border-line bg-track px-3 text-sm font-semibold text-muted opacity-70">Post to page</button>
        </div>
        {error && <p role="alert" className="text-xs text-warn">{error}</p>}
        <p className="text-xs text-muted">Scheduling and posting to your page are coming soon. For now, copy the caption and post it yourself.</p>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
    </>
  )
}
