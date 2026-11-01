const STYLE = {
  in_stock: ['In stock', 'bg-accent-soft text-accent-dark'],
  pre_order: ['Pre-order', 'bg-info-soft text-info'],
  sold_out: ['Sold out', 'bg-warn-soft text-warn'],
}

export function StatusChip({ status }) {
  const [label, style] = STYLE[status] ?? STYLE.in_stock
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${style}`}>{label}</span>
}
