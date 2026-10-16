import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { getCurrentUser } from '@/server/auth/current-user'
import { logout } from '../logout/actions'

export default function PlatformPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <PlatformContent />
      </Suspense>
    </main>
  )
}

async function PlatformContent() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  if (!user.isPlatformAdmin) redirect('/')
  return (
    <>
      <p className="text-lg">Platform admin — coming soon</p>
      <form action={logout}>
        <Button type="submit" variant="outline">
          Log out
        </Button>
      </form>
    </>
  )
}
