import { EmptyState, ScreenHeader } from '../components/ui'

export function Orders() {
  return (
    <>
      <ScreenHeader title="Orders" subtitle="Orders found in your comments" />
      <EmptyState title="No orders to review yet">Orders and leads from comments will appear here for you to confirm.</EmptyState>
    </>
  )
}
