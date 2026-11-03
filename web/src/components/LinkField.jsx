import { useState } from 'react'
import { getAuth } from '../api'
import { linkProblem } from '../linkTools'

// The optional link the caption carries: website, product page, or an m.me link to order on Messenger.
// Facebook shows the photos, not a link preview, when a post has photos, so the link appears as text in the caption.
export function LinkField({ session, value, onChange, disabled }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const problem = linkProblem(value)
  const messenger = async () => {
    setBusy(true); setError(null)
    try { onChange((await getAuth(`/pages/${session.page.id}/messenger-link`, session.token)).link) } catch (e) { setError(e.message) }
    setBusy(false)
  }
  return (
    <div className="flex flex-col gap-1.5 text-xs font-semibold text-muted">
      <label className="flex flex-col gap-1">Link (optional)
        <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} inputMode="url" autoCapitalize="none" spellCheck={false}
          placeholder="https://… or https://m.me/yourpage" aria-invalid={!!problem}
          className={`min-h-11 rounded-btn border px-3 text-[15px] font-normal text-ink ${problem ? 'border-warn' : 'border-line'}`} />
      </label>
      {problem && <span role="alert" className="font-normal text-warn">{problem}</span>}
      <button type="button" onClick={messenger} disabled={busy || disabled} className="min-h-11 self-start rounded-btn border border-line bg-white px-3 text-sm font-bold text-ink disabled:opacity-60">
        {busy ? 'Adding…' : 'Add Messenger order link'}
      </button>
      {error && <span role="alert" className="font-normal text-warn">{error}</span>}
      <span className="font-normal">Facebook shows your photos, not a link preview, when a post has photos. The link appears as text in the caption, written exactly as you enter it.</span>
    </div>
  )
}
