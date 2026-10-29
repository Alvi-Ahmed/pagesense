import { EmptyState, ScreenHeader } from '../components/ui'

export function Catalog() {
  return (
    <>
      <ScreenHeader title="Catalog" subtitle="Products from your posts" />
      <EmptyState title="Your catalog will appear when analysis finishes">We build it from your posts, and you can edit anything.</EmptyState>
    </>
  )
}
