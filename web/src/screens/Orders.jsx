import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { API_URL, getAuth, patch, post } from '../api'
import { applyLocal, changeLocal, countOrders, ordersCsv } from '../ordersLocal'
import { EmptyState, ErrorState, ScreenHeader, Skeleton } from '../components/ui'

const TABS = [['to_review', 'To review'], ['confirmed', 'Confirmed'], ['delivered', 'Delivered']]
const LABEL = { size: 'size', quantity: 'quantity', phone: 'phone number', address: 'address' }
const input = 'min-h-11 rounded-btn border border-line px-3 text-[15px] font-normal text-ink'

function Detail({ label, value }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] font-semibold text-muted">{label}</span>
      <span className={`text-sm font-bold ${value == null || value === '' ? 'text-amber-ink' : ''}`}>{value == null || value === '' ? '?' : value}</span>
    </div>
  )
}

function ReplyPanel({ state }) {
  const [copied, setCopied] = useState(false)
  if (state.loading) return <Skeleton className="h-20" />
  if (state.error) return <p role="alert" className="rounded-btn bg-warn-soft px-3 py-2 text-sm text-warn">{state.error}</p>
  const copy = async () => { try { await navigator.clipboard.writeText(state.reply); setCopied(true) } catch { /* the text is selectable */ } }
  return (
    <div className="flex flex-col gap-2 rounded-btn bg-accent-soft p-3">
      <p className="text-xs font-semibold text-accent-dark">Suggested reply ({state.language}). Nothing is sent: copy it and reply on Facebook.</p>
      <textarea readOnly value={state.reply} rows={3} aria-label="Suggested reply" className="rounded-btn border border-accent-pale bg-white px-3 py-2 text-sm leading-relaxed" />
      <button onClick={copy} className="min-h-11 rounded-btn bg-accent px-4 text-sm font-bold text-white">{copied ? 'Copied!' : 'Copy reply'}</button>
    </div>
  )
}

function EditForm({ order, onSave, onCancel, busy }) {
  const [f, setF] = useState({ size: order.size ?? '', color: order.color ?? '', quantity: order.quantity ?? '', phone: order.phone ?? '', address: order.address ?? '' })
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="flex flex-col gap-2.5 rounded-btn border border-line bg-bg p-3">
      {[['size', 'Size'], ['color', 'Color'], ['quantity', 'Quantity'], ['phone', 'Phone number'], ['address', 'Delivery address']].map(([k, label]) => (
        <label key={k} className="flex flex-col gap-1 text-xs font-semibold text-muted">{label}
          <input value={f[k]} onChange={set(k)} inputMode={k === 'quantity' ? 'numeric' : k === 'phone' ? 'tel' : undefined} className={input} />
        </label>
      ))}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => onSave({ ...f, quantity: f.quantity === '' ? null : f.quantity })} disabled={busy} className="min-h-11 rounded-btn bg-accent px-3 text-sm font-bold text-white disabled:opacity-50">Save</button>
        <button onClick={onCancel} className="min-h-11 rounded-btn border border-line bg-white px-3 text-sm font-bold">Cancel</button>
      </div>
    </div>
  )
}

function Card({ order, busy, act }) {
  const [reply, setReply] = useState(null)
  const [editing, setEditing] = useState(false)
  const lead = order.kind === 'lead'
  const askable = !lead && order.missing.length > 0 && order.status === 'to_review'

  const ask = async () => {
    if (reply && !reply.error) { setReply(null); return }
    setReply({ loading: true })
    try { setReply(await act.reply(order)) } catch (e) { setReply({ error: e.message }) }
  }
  const save = async (fields) => { if (await act.edit(order, fields)) setEditing(false) }

  return (
    <li className={`flex flex-col gap-3 rounded-card p-4 ${lead ? 'border border-dashed border-info bg-info-soft/40' : 'border border-line bg-white'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-bold">{order.product?.name ?? 'Product not in your catalog yet'}</p>
          <p className="line-clamp-1 text-xs text-muted">{order.customer}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${lead ? 'bg-info-soft text-info' : 'bg-accent-soft text-accent-dark'}`}>{lead ? 'Lead' : 'Order'}</span>
      </div>

      {order.conversation?.length
        ? (
          <ol aria-label="Messenger chat" className="flex flex-col gap-1.5 rounded-btn bg-bg px-3 py-2.5 text-sm">
            {order.conversation.slice(-6).map((m, i) => (
              <li key={i} className={m.from === 'page' ? 'self-end rounded-xl bg-accent-soft px-2.5 py-1.5 text-right text-accent-dark' : 'self-start rounded-xl bg-white px-2.5 py-1.5'}>
                <span className="sr-only">{m.from === 'page' ? 'You: ' : 'Customer: '}</span>{m.text}
              </li>
            ))}
          </ol>
        )
        : (
          <blockquote className="rounded-btn bg-bg px-3 py-2 text-sm italic">
            “{order.comment}”
            {order.followups.map((f, i) => <span key={i} className="mt-1 block not-italic text-muted">↳ {f}</span>)}
          </blockquote>
        )}

      {lead
        ? <p className="text-xs text-muted">They showed interest but did not say they want to buy. If you think they do, mark it as an order.</p>
        : (
          <>
            <div className="grid grid-cols-3 gap-2"><Detail label="Size" value={order.size} /><Detail label="Quantity" value={order.quantity} /><Detail label="Color" value={order.color} /></div>
            <div className="grid grid-cols-2 gap-2"><Detail label="Phone" value={order.phone} /><Detail label="Address" value={order.address} /></div>
            {order.missing.length > 0 && order.status !== 'delivered' && (
              <p className="rounded-btn bg-amber-soft px-3 py-2 text-sm font-semibold text-amber-ink">Missing: {order.missing.map((m) => LABEL[m]).join(', ')}</p>
            )}
          </>
        )}

      {reply && <ReplyPanel state={reply} />}
      {editing && <EditForm order={order} busy={busy} onSave={save} onCancel={() => setEditing(false)} />}

      <div className="flex flex-wrap gap-2">
        {order.comment_url && <a href={order.comment_url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center rounded-btn border border-line bg-white px-3 text-sm font-semibold text-info no-underline">Open comment</a>}
        {askable && <button onClick={ask} className="min-h-11 rounded-btn border border-line bg-white px-3 text-sm font-semibold">Ask for details</button>}
        {!lead && !editing && order.status !== 'cancelled' && <button onClick={() => setEditing(true)} className="min-h-11 rounded-btn border border-line bg-white px-3 text-sm font-semibold">Edit</button>}
      </div>

      <div className="flex flex-wrap gap-2">
        {lead && <button onClick={() => act.convert(order)} disabled={busy} className="min-h-11 flex-1 rounded-btn bg-info px-4 text-sm font-bold text-white disabled:opacity-50">Mark as order</button>}
        {!lead && order.status === 'to_review' && <button onClick={() => act.status(order, 'confirmed')} disabled={busy} className="min-h-11 flex-1 rounded-btn bg-accent px-4 text-sm font-bold text-white disabled:opacity-50">Confirm</button>}
        {order.status === 'confirmed' && <>
          <button onClick={() => act.status(order, 'delivered')} disabled={busy} className="min-h-11 flex-1 rounded-btn bg-accent px-4 text-sm font-bold text-white disabled:opacity-50">Mark delivered</button>
          <button onClick={() => act.status(order, 'to_review')} disabled={busy} className="min-h-11 rounded-btn border border-line bg-white px-4 text-sm font-bold disabled:opacity-50">Undo</button>
        </>}
        {order.status === 'delivered' && <button onClick={() => act.status(order, 'confirmed')} disabled={busy} className="min-h-11 rounded-btn border border-line bg-white px-4 text-sm font-bold disabled:opacity-50">Undo</button>}
        {order.status === 'cancelled' && <button onClick={() => act.status(order, 'to_review')} disabled={busy} className="min-h-11 rounded-btn border border-line bg-white px-4 text-sm font-bold disabled:opacity-50">Restore</button>}
        {(order.status === 'to_review' || order.status === 'confirmed') && (
          <button onClick={() => act.status(order, 'cancelled')} disabled={busy} className="min-h-11 rounded-btn px-3 text-sm font-semibold text-warn disabled:opacity-50">{lead ? 'Dismiss' : 'Cancel'}</button>
        )}
      </div>
    </li>
  )
}

export function Orders() {
  const { session, analysis } = useOutletContext()
  const pageId = session.page.id
  const demo = session.demo
  const [list, setList] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [version, setVersion] = useState(0) // bumps after a change, so the list is read again
  const [tab, setTab] = useState('to_review')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)
  const [info, setInfo] = useState(null) // what confirming or undoing did to stock

  useEffect(() => {
    let cancelled = false
    getAuth(`/pages/${pageId}/orders`, session.token)
      .then((r) => { if (!cancelled) { setList(r.orders); setError(null) } })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [pageId, session.token, analysis?.finished_at, attempt, version])

  const orders = useMemo(() => (list ? (demo ? applyLocal(list) : list) : []), [list, demo, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => countOrders(orders), [orders])

  const run = async (fn) => {
    setBusy(true); setNotice(null)
    try { await fn(); setVersion((v) => v + 1); return true } catch (e) { setNotice(e.message); return false } finally { setBusy(false) }
  }
  const token = { accessToken: session.token }
  const act = {
    status: (o, status) => run(async () => {
      setInfo(null)
      if (demo) changeLocal(o.id, { status })
      else setInfo((await post(`/pages/${pageId}/orders/${o.id}/status`, { status, ...token })).stock_note)
    }),
    convert: (o) => run(async () => { if (demo) changeLocal(o.id, { kind: 'order' }); else await post(`/pages/${pageId}/orders/${o.id}/convert`, token) }),
    edit: (o, fields) => run(async () => {
      if (demo) {
        const q = fields.quantity == null || fields.quantity === '' ? null : Math.floor(Number(fields.quantity))
        if (q !== null && (!Number.isFinite(q) || q < 1 || q > 999)) throw new Error('Quantity must be a whole number from 1 to 999.')
        changeLocal(o.id, { size: fields.size.trim() || null, color: fields.color.trim().toLowerCase() || null, quantity: q, phone: fields.phone.trim() || null, address: fields.address.trim() || null })
      } else await patch(`/pages/${pageId}/orders/${o.id}`, { ...fields, ...token })
    }),
    // a suggested reply never changes anything, so the demo may ask for one too (it is rate limited)
    reply: (o) => post(`/pages/${pageId}/orders/${o.id}/reply`, token),
  }

  // reads the page's Messenger chats (read only, nothing is sent) and makes cards for new orders and leads
  const checkMessages = () => run(async () => {
    const r = await post(`/pages/${pageId}/orders/sync`, token)
    setInfo(r.created ? `Found ${r.orders} new ${r.orders === 1 ? 'order' : 'orders'} and ${r.leads} ${r.leads === 1 ? 'lead' : 'leads'} in ${r.total} new or changed chats.` : `No new orders. ${r.checked} chats checked.`)
  })

  const exportCsv = () => run(async () => {
    const confirmed = orders.filter((o) => o.status === 'confirmed' && o.kind === 'order')
    let blob
    if (demo) blob = new Blob([`\uFEFF${ordersCsv(confirmed)}`], { type: 'text/csv;charset=utf-8' })
    else {
      const res = await fetch(`${API_URL}/pages/${pageId}/orders/export`, { headers: { 'x-access-token': session.token } })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Export failed (HTTP ${res.status})`)
      blob = await res.blob()
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `orders-confirmed-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  })

  const header = <ScreenHeader title="Orders" subtitle="Orders found in your Messenger chats" />
  if (error && !list) return <>{header}<ErrorState message={error} onRetry={() => setAttempt((n) => n + 1)} /></>
  if (!list) return <>{header}<Skeleton className="h-12" /><Skeleton className="h-48" /><Skeleton className="h-48" /></>

  const shown = orders.filter((o) => (tab === 'cancelled' ? o.status === 'cancelled' : o.status === tab))
  const realOrders = shown.filter((o) => o.kind === 'order')
  const leads = shown.filter((o) => o.kind === 'lead')
  const count = (id) => (id === 'to_review' ? counts.to_review : counts[id])

  return (
    <>
      {header}
      <div role="tablist" aria-label="Orders" className="grid grid-cols-3 gap-1 rounded-btn bg-track p-1">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`min-h-11 rounded-[10px] text-sm font-semibold ${tab === id ? 'bg-white text-accent-dark shadow-sm' : 'text-muted'}`}>
            {label} <span className="font-bold">{count(id)}</span>
          </button>
        ))}
      </div>
      {counts.cancelled > 0 && (
        <button onClick={() => setTab(tab === 'cancelled' ? 'to_review' : 'cancelled')} className="min-h-9 self-end text-xs font-semibold text-muted underline">
          {tab === 'cancelled' ? 'Back to orders' : `Cancelled (${counts.cancelled})`}
        </button>
      )}
      {notice && <ErrorState message={notice} />}
      {info && <p role="status" className="rounded-card bg-accent-soft px-4 py-3 text-sm font-semibold text-accent-dark">{info}</p>}
      {demo && <p className="text-xs text-muted">Demo mode: made-up Messenger chats. Status changes and edits stay in this browser tab.</p>}
      {!demo && <button onClick={checkMessages} disabled={busy} className="min-h-12 rounded-btn border border-line bg-white px-5 text-[15px] font-bold disabled:opacity-50">{busy ? 'Working…' : 'Check messages'}</button>}

      {tab === 'confirmed' && counts.confirmed > 0 && (
        <button onClick={exportCsv} disabled={busy} className="min-h-12 rounded-btn border border-accent bg-white px-5 text-[15px] font-bold text-accent-dark disabled:opacity-50">
          Export confirmed orders (CSV)
        </button>
      )}

      {realOrders.length === 0 && leads.length === 0 && (
        <EmptyState title={tab === 'to_review' ? 'No orders to review' : tab === 'confirmed' ? 'Nothing confirmed yet' : tab === 'delivered' ? 'Nothing delivered yet' : 'Nothing cancelled'}>
          {orders.length === 0
            ? (demo ? 'The demo page has no Messenger orders.' : 'Customers order in Messenger. Press "Check messages" to bring their orders here for you to confirm.')
            : 'Orders move here as you work through them.'}
        </EmptyState>
      )}
      {realOrders.length > 0 && <ul className="flex flex-col gap-3">{realOrders.map((o) => <Card key={o.id} order={o} busy={busy} act={act} />)}</ul>}
      {leads.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-[17px] font-bold">Leads <span className="text-sm font-semibold text-muted">{leads.length}</span></h2>
          <p className="text-sm text-muted">Chats that show interest but do not say they want to buy.</p>
          <ul className="flex flex-col gap-3">{leads.map((o) => <Card key={o.id} order={o} busy={busy} act={act} />)}</ul>
        </section>
      )}
    </>
  )
}

