import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/server/auth/current-user'
import { requireTenant } from '@/server/tenant'

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-6">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <RoleRedirect />
      </Suspense>
    </main>
  )
}

/** `/` only routes: platform admin -> /platform, owner/manager -> /admin, cashier -> /till. */
async function RoleRedirect() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.isPlatformAdmin) redirect('/platform')
  const ctx = await requireTenant()
  return redirect(ctx.role === 'cashier' ? '/till' : '/admin')
}
