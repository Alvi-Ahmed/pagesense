import { useEffect, useState } from 'react'
import { useLocation, useOutletContext } from 'react-router-dom'
import { get, patch, post } from '../api'
import { fromDraft, loadDrafts, saveDemoDraft, updateDemoDraft } from '../drafts'
import { ErrorState, ScreenHeader, Skeleton } from '../components/ui'

const LANGUAGES = [['bangla', 'বাংলা'], ['english', 'English'], ['banglish', 'Banglish']]
const LABEL = { PRICE: 'Price', SIZES: 'Sizes', COLORS: 'Colors', 'DELIVERY CHARGE': 'Delivery charge', STOCK: 'Stock count' }
const PLACEHOLDER = /\[(PRICE|SIZES|COLORS|DELIVERY CHARGE|STOCK)\]/g

const fillIn = (text, values) => text.replace(PLACEHOLDER, (m, key) => values[key]?.trim() || m)
const placeholdersIn = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))]

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

function Card({ title, children }) {
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-white px-4 py-4">
      <h2 className="text-[15px] font-bold">{title}</h2>
      {children}
    </section>
  )
}

const chip = (pattern) => (pattern ? `${pattern.pattern}: ${pattern.value}` : 'Playbook tip')

export function Create() {
  const { session } = useOutletContext()
  const from = useLocation().state || {} // set by Home ("Create this post"), the Playbook ("Improve this post") and drafts
  const pageId = session.page.id

  const [products, setProducts] = useState(null)
  const [productKey, setProductKey] = useState(null)
  const [freeText, setFreeText] = useState(false)
  const [description, setDescription] = useState('')
  const [language, setLanguage] = useState(from.language || 'banglish')
  const [hint, setHint] = useState(from.hint || null)
  const [result, setResult] = useState(null)
  const [template, setTemplate] = useState('')
  const [values, setValues] = useState({})
  const [pending, setPending] = useState(!!(from.improvePostId || from.draftId))
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [improveId, setImproveId] = useState(from.improvePostId || null)

  const adopt = (r) => {
    setResult(r); setTemplate(r.caption); setValues({}); setCopied(false)
    if (r.language) setLanguage(r.language)
    if (r.kind === 'improve' && r.source_post_id) setImproveId(r.source_post_id)
  }
  // demo drafts only exist in this tab; real ones were already saved by the server
  const stash = (r) => (session.demo ? { ...r, draft_id: saveDemoDraft(r).id } : r)
  const settle = async (promise) => {
    try { adopt(await promise) } catch (e) { setError(e.message) }
    setPending(false)
  }
  const start = (promise) => { setPending(true); setError(null); settle(promise) }

  const generate = (lang = language) => start(post(`/pages/${pageId}/posts/generate`, {
    accessToken: session.token, language: lang, hint,
    ...(freeText ? { description } : { productKey }),
  }).then(stash))
  const improve = (lang) => start(post(`/pages/${pageId}/posts/improve`, {
    accessToken: session.token, postId: improveId, ...(lang && { language: lang }),
  }).then(stash))

  // first load: the product list, then whatever brought us here
  useEffect(() => {
    let cancelled = false
    get(`/pages/${pageId}/posts/products`)
      .then(({ products: list }) => {
        if (cancelled) return
        setProducts(list)
        if (list.length) setProductKey((k) => k ?? list[0].key)
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    if (from.improvePostId) {
      post(`/pages/${pageId}/posts/improve`, { accessToken: session.token, postId: from.improvePostId })
        .then((r) => adopt(stash(r)))
        .catch((e) => setError(e.message))
        .finally(() => setPending(false))
    }
    else if (from.draftId) {
      loadDrafts(session)
        .then((list) => {
          const d = list.find((x) => x.id === from.draftId)
          if (!d) throw new Error('That draft is no longer here.')
          adopt(fromDraft(d)); setPending(false)
        })
        .catch((e) => { setError(e.message); setPending(false) })
    }
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per visit; `from` is the navigation state
  }, [pageId])

  const pickLanguage = (lang) => {
    if (lang === language) return
    setLanguage(lang)
    if (improveId && result) improve(lang) // switching regenerates
    else if (result && (productKey || (freeText && description.trim()))) generate(lang)
  }

  const saveEdit = async () => {
    if (!result?.draft_id || template === result.caption) return
    try {
      if (session.demo) updateDemoDraft(result.draft_id, template)
      else await patch(`/pages/${pageId}/drafts/${result.draft_id}`, { caption: template, accessToken: session.token })
      setResult({ ...result, caption: template })
    } catch (e) { setError(e.message) }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(fillIn(template, values)); setCopied(true) }
    catch { setError('Could not copy. Select the text in the box and copy it by hand.') }
  }

  const product = products?.find((p) => p.key === productKey)
  const photo = result?.photo_url ?? (improveId ? null : product?.photo_url)
  const open = placeholdersIn(fillIn(template, values))
  const needsInput = freeText ? !description.trim() : !productKey
  const improving = !!improveId

  return (
    <>
      <ScreenHeader title={improving ? 'Improve your post' : 'Create a post'} subtitle="Written in your voice, from what works on your page" />

      {hint && (
        <p className="flex items-start gap-2 rounded-card bg-accent-soft px-4 py-3 text-sm text-accent-dark">
          <span className="flex-1"><strong>From your playbook:</strong> {hint}</span>
          <button onClick={() => setHint(null)} aria-label="Dismiss" className="min-h-8 px-1 font-bold">×</button>
        </p>
      )}

      {!improving && (
        <Card title="What are you selling?">
          {!products ? <Skeleton className="h-20" /> : (
            <>
              {!freeText && (
                <ul className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1" aria-label="Products">
                  {products.map((p) => (
                    <li key={p.key} className="shrink-0">
                      <button onClick={() => setProductKey(p.key)} aria-pressed={p.key === productKey}
                        className={`flex w-[76px] flex-col items-center gap-1 rounded-card border p-1.5 text-center text-xs ${p.key === productKey ? 'border-accent bg-accent-soft font-bold' : 'border-line'}`}>
                        <img src={p.photo_url} alt="" loading="lazy" className="size-14 rounded-btn bg-track object-cover" />
                        <span className="w-full truncate">{p.label}</span>
                        <span className="text-[10px] text-muted">{p.posts} posts</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {freeText && (
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={600}
                  placeholder="For example: handmade cotton saree, 3 colors"
                  className="rounded-btn border border-line px-3 py-2.5 text-[15px]" />
              )}
              <button onClick={() => setFreeText(!freeText)} className="min-h-11 self-start text-sm font-semibold text-info">
                {freeText ? 'Pick from my products instead' : 'Describe it myself instead'}
              </button>
            </>
          )}
        </Card>
      )}

      <div role="radiogroup" aria-label="Language" className="grid grid-cols-3 gap-1 rounded-btn bg-track p-1">
        {LANGUAGES.map(([id, label]) => (
          <button key={id} role="radio" aria-checked={language === id} disabled={pending} onClick={() => pickLanguage(id)}
            className={`min-h-11 rounded-[10px] text-sm font-semibold disabled:opacity-60 ${language === id ? 'bg-white text-accent-dark shadow-sm' : 'text-muted'}`}>
            {label}
          </button>
        ))}
      </div>

      {!result && !improving && (
        <button onClick={() => generate()} disabled={pending || needsInput}
          className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white disabled:opacity-50">
          {pending ? 'Writing…' : 'Write my post'}
        </button>
      )}

      {pending && (
        <div role="status" className="flex flex-col gap-2.5">
          <p className="text-sm text-muted">Writing your post. This can take up to 30 seconds.</p>
          <Skeleton className="h-40" />
        </div>
      )}
      {error && <ErrorState message={error} onRetry={improving ? () => improve(result?.language ? language : undefined) : result || !needsInput ? () => generate() : undefined} />}

      {result && !pending && (
        <>
          {photo && <img src={photo} alt="Photo for this post" className="aspect-square w-full rounded-card bg-track object-cover" />}

          <Card title="Your caption">
            <textarea value={template} onChange={(e) => { setTemplate(e.target.value); setCopied(false) }} onBlur={saveEdit}
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
            <button onClick={copy} className="min-h-12 rounded-btn bg-accent px-5 text-[15px] font-bold text-white">
              {copied ? 'Copied!' : 'Copy caption'}
            </button>
            <button onClick={() => (improving ? improve(language) : generate())}
              className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold">
              Regenerate
            </button>
            <div className="grid grid-cols-2 gap-2.5">
              <button disabled className="min-h-12 rounded-btn border border-line bg-track px-3 text-sm font-semibold text-muted opacity-70">Schedule</button>
              <button disabled className="min-h-12 rounded-btn border border-line bg-track px-3 text-sm font-semibold text-muted opacity-70">Post to page</button>
            </div>
            <p className="text-xs text-muted">Scheduling and posting to your page are coming soon. For now, copy the caption and post it yourself.</p>
            <p className="text-xs text-muted">
              {session.demo ? 'Demo mode: your drafts stay in this browser tab only.' : 'Saved as a draft on your page.'}
            </p>
          </div>
        </>
      )}
    </>
  )
}
