const base = {
  width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}
const icon = (children) => (props) => <svg {...base} {...props}>{children}</svg>

export const HomeIcon = icon(<><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /></>)
export const PlaybookIcon = icon(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />)
export const CreateIcon = icon(<><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8v8M8 12h8" /></>)
export const OrdersIcon = icon(<><path d="M6 7h12l-1 13H7L6 7Z" /><path d="M9 7a3 3 0 0 1 6 0" /></>)
export const CatalogIcon = icon(<><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>)
export const CheckIcon = icon(<path d="M20 6 9 17l-5-5" />)
export const MoreIcon = icon(<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>)
