import { EmptyState, ScreenHeader } from '../components/ui'

export function Create() {
  return (
    <>
      <ScreenHeader title="Create a post" subtitle="A new post in your voice" />
      <EmptyState title="Post ideas will appear when analysis finishes">Once we know what works on your page, you can create and approve a post here.</EmptyState>
    </>
  )
}
