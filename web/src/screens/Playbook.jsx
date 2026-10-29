import { EmptyState, ScreenHeader } from '../components/ui'

export function Playbook() {
  return (
    <>
      <ScreenHeader title="Your playbook" subtitle="What works on your page" />
      <EmptyState title="Your playbook will appear when analysis finishes">We compare your posts, offers and prices to find what your customers respond to.</EmptyState>
    </>
  )
}
