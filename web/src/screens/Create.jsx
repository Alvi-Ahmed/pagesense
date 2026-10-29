import { useState } from 'react'
import { useLocation, useOutletContext } from 'react-router-dom'
import { ScreenHeader } from '../components/ui'
import { CreateExisting } from './CreateExisting'
import { CreateNew } from './CreateNew'

// Two ways to make a post. A new product (upload photos) is how sellers usually start, so it comes first;
// a product already in the page's history, an improvement, or a saved draft is the second option.
export function Create() {
  const { session } = useOutletContext()
  const from = useLocation().state || {} // set by Home ("Create this post"), the Playbook ("Improve this post") and drafts
  const [mode, setMode] = useState(from.improvePostId || from.draftId ? 'existing' : 'new')
  const [hint, setHint] = useState(from.hint || null)
  const improving = mode === 'existing' && !!from.improvePostId

  return (
    <>
      <ScreenHeader title={improving ? 'Improve your post' : 'Create a post'} subtitle="Written in your voice, from what works on your page" />

      {hint && (
        <p className="flex items-start gap-2 rounded-card bg-accent-soft px-4 py-3 text-sm text-accent-dark">
          <span className="flex-1"><strong>From your playbook:</strong> {hint}</span>
          <button onClick={() => setHint(null)} aria-label="Dismiss" className="min-h-8 px-1 font-bold">×</button>
        </p>
      )}

      {mode === 'new'
        ? <CreateNew session={session} />
        : <CreateExisting session={session} from={from} hint={hint} />}

      {!improving && (
        <button onClick={() => setMode(mode === 'new' ? 'existing' : 'new')} className="min-h-11 self-center text-sm font-semibold text-info">
          {mode === 'new' ? 'Or post about a product you already sell' : 'Or upload photos of a new product'}
        </button>
      )}
    </>
  )
}
