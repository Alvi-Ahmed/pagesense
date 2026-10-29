import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { Banner } from './Banner'
import { CatalogIcon, CheckIcon, CreateIcon, HomeIcon, MoreIcon, OrdersIcon, PlaybookIcon } from './Icons'
import { usePageStatus } from '../usePageStatus'

const TABS = [
  { to: '/', label: 'Home', Icon: HomeIcon, end: true },
  { to: '/playbook', label: 'Playbook', Icon: PlaybookIcon },
  { to: '/create', label: 'Create', Icon: CreateIcon },
  { to: '/orders', label: 'Orders', Icon: OrdersIcon },
  { to: '/catalog', label: 'Catalog', Icon: CatalogIcon },
]

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function Shell({ session, onDisconnect }) {
  const status = usePageStatus(session)
  const [menu, setMenu] = useState(false)
  const syncing = status.sync?.status === 'running'
  const posts = syncing ? status.sync.posts : status.summary?.posts

  return (
    <div className="mx-auto flex min-h-svh max-w-[430px] flex-col bg-bg shadow-sm">
      <Banner sync={status.sync} analysis={status.analysis} error={status.error}
        canRetry={!!session.token || session.demo} onRetry={status.retry} />

      <header className="relative flex items-center justify-between gap-3 px-5 pt-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-accent text-lg font-bold text-white">
            {session.page.name?.[0]?.toUpperCase() ?? 'S'}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] text-muted">{session.demo ? 'Demo mode' : greeting()}</span>
            <span className="text-[17px] font-bold">{session.page.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-semibold ${syncing ? 'bg-info-soft text-info' : 'bg-accent-soft text-accent-dark'}`}>
            {!syncing && <CheckIcon width={14} height={14} strokeWidth={2.2} />}
            {syncing ? 'Syncing' : 'Synced'} · {posts ?? '…'} posts
          </span>
          <button aria-label="Menu" aria-expanded={menu} onClick={() => setMenu(!menu)}
            className="flex h-11 w-9 items-center justify-center rounded-btn text-muted">
            <MoreIcon />
          </button>
        </div>
        {menu && (
          <div className="absolute top-[72px] right-5 z-20 rounded-card border border-line bg-white p-1 shadow-lg">
            <button onClick={onDisconnect} className="min-h-11 w-full rounded-btn px-4 text-left text-sm font-semibold text-warn">
              {session.demo ? 'Exit demo' : 'Disconnect page'}
            </button>
          </div>
        )}
      </header>

      <main className="flex flex-1 flex-col gap-5 px-5 pt-5 pb-28">
        <Outlet context={{ session, ...status }} />
      </main>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10">
        <div className="mx-auto grid max-w-[430px] grid-cols-5 border-t border-line bg-white px-1 pt-1.5 pb-2.5">
          {TABS.map(({ to, label, Icon, end }) => (
            <NavLink key={to} to={to} end={end}
              className={({ isActive }) =>
                `flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] no-underline ${isActive ? 'font-bold text-accent' : 'font-semibold text-muted'}`}>
              <Icon />{label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}
