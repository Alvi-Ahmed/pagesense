// Shared building blocks so every screen has the same loading / empty / error states.
export function EmptyState({ title, children }) {
  return (
    <div className="rounded-card border border-dashed border-line bg-white px-5 py-8 text-center">
      <p className="text-[15px] font-bold">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  )
}

export function Skeleton({ className = 'h-24' }) {
  return <div className={`animate-pulse rounded-card bg-track ${className}`} />
}

export function ErrorState({ message, onRetry }) {
  return (
    <div role="alert" className="rounded-card bg-warn-soft px-4 py-3 text-sm text-warn">
      <p>{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 min-h-11 rounded-btn bg-warn px-4 font-semibold text-white">
          Retry
        </button>
      )}
    </div>
  )
}

export function ScreenHeader({ title, subtitle }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-[26px] font-bold">{title}</h1>
      {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
    </header>
  )
}
