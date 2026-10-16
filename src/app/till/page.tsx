import { Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { requireTenant } from '@/server/tenant'
import { logout } from '../logout/actions'

export default function TillPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <TillContent />
      </Suspense>
    </main>
  )
}

async function TillContent() {
  await requireTenant()
  return (
    <>
      <p className="text-lg">The till arrives in Phase 3.</p>
      <form action={logout}>
        <Button type="submit" variant="outline">
          Log out
        </Button>
      </form>
    </>
  )
}
