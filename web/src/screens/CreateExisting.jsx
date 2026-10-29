import { useEffect, useState } from 'react'
import { get, patch, post } from '../api'
import { fromDraft, loadDrafts, saveDemoDraft, updateDemoDraft } from '../drafts'
import { Card, LanguageToggle, PostEditor } from '../components/PostEditor'
import { ErrorState, Skeleton } from '../components/ui'

// "Post about a product I already sell": pick a product found in the page's photo tags (or describe one),
// or improve an existing post, or reopen a draft.
export function CreateExisting({ session, from, hint }) {
  const pageId = session.page.id
  const [products, setProducts] = useState(null)
  const [productKey, setProductKey] = useState(null)
  const [freeText, setFreeText] = useState(false)
  const [description, setDescription] = useState('')
  const [language, setLanguage] = useState(from.language || 'banglish')
  const [result, setResult] = useState(null)
  const [resultKey, setResultKey] = useState(0)
  const [pending, setPending] = useState(!!(from.improvePostId || from.draftId))
  const [error, setError] = useState(null)
  const [improveId, setImproveId] = useState(from.improvePostId || null)

  const adopt = (r) => {
    setResult(r); setResultKey((k) => k + 1)
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
    accessToken: session.token, language: lang, hint, ...(freeText ? { description } : { productKey }),
  }).then(stash))
  const improve = (lang) => start(post(`/pages/${pageId}/posts/improve`, {
    accessToken: session.token, postId: improveId, ...(lang && { language: lang }),
  }).then(stash))

  // first load: the product list, then whatever brought us here (an improve request or a saved draft)
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
    } else if (from.draftId) {
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

  const saveEdit = async (caption) => {
    if (!result?.draft_id || caption === result.caption) return
    try {
      if (session.demo) updateDemoDraft(result.draft_id, caption)
      else await patch(`/pages/${pageId}/drafts/${result.draft_id}`, { caption, accessToken: session.token })
      setResult({ ...result, caption })
    } catch (e) { setError(e.message) }
  }

  const product = products?.find((p) => p.key === productKey)
  const photo = result?.photo_url ?? (improveId ? null : product?.photo_url)
  const needsInput = freeText ? !description.trim() : !productKey
  const improving = !!improveId

  return (
    <>
      {!improving && (
        <Card title="Which product?">
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

      <LanguageToggle language={language} onChange={pickLanguage} disabled={pending} />

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
      {error && <ErrorState message={error} onRetry={improving ? () => improve(language) : result || !needsInput ? () => generate() : undefined} />}

      {result && !pending && (
        <PostEditor key={resultKey} result={result} photo={photo} onSaveEdit={saveEdit}
          onRegenerate={() => (improving ? improve(language) : generate())}
          note={session.demo ? 'Demo mode: your drafts stay in this browser tab only.' : 'Saved as a draft on your page.'} />
      )}
    </>
  )
}
