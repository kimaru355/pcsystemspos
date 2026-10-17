import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { AppShell } from '@/components/shell/app-shell'
import { getCurrentUser } from '@/server/auth/current-user'

export default function PlatformLayout({ children }: LayoutProps<'/platform'>) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh flex-1">
          <div className="hidden w-60 shrink-0 bg-rail md:block" />
          <p className="p-8 text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <PlatformShell>{children}</PlatformShell>
    </Suspense>
  )
}

async function PlatformShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.mustChangePassword) redirect('/change-password')
  if (!user.isPlatformAdmin) redirect('/')
  return (
    <AppShell nav="platform" context="Platform admin" account={{ name: user.name, detail: 'Platform admin' }}>
      {children}
    </AppShell>
  )
}
