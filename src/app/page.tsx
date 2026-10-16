import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { getCurrentUser } from '@/server/auth/current-user'
import { logout } from './logout/actions'

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">PC Systems POS</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Account />
      </Suspense>
    </main>
  )
}

async function Account() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return (
    <>
      <p className="text-sm">Signed in as {user.name}</p>
      <form action={logout}>
        <Button type="submit" variant="outline">
          Log out
        </Button>
      </form>
    </>
  )
}
