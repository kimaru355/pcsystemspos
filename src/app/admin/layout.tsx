import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { ShoppingCart } from 'lucide-react'
import { db } from '@/db/client'
import { businesses } from '@/db/schema'
import { ROLE_LABELS } from '@/domain/permissions'
import { buttonVariants } from '@/components/ui/button'
import { AppShell } from '@/components/shell/app-shell'
import { OutletFilter } from '@/components/shell/outlet-filter'
import { getCurrentUser } from '@/server/auth/current-user'
import { readOutletFilter } from '@/server/outlet-filter'
import { listOutlets } from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'

export default function AdminLayout({ children }: LayoutProps<'/admin'>) {
  return (
    <Suspense fallback={<ShellFallback />}>
      <AdminShell>{children}</AdminShell>
    </Suspense>
  )
}

function ShellFallback() {
  return (
    <div className="flex min-h-dvh flex-1">
      <div className="hidden w-60 shrink-0 bg-rail md:block" />
      <p className="p-8 text-sm text-muted-foreground">Loading…</p>
    </div>
  )
}

/** Owners and managers only; cashiers belong at the till. */
async function AdminShell({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenant()
  if (ctx.role === 'cashier') redirect('/till')
  const [user, [business], outlets] = await Promise.all([
    getCurrentUser(),
    db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, ctx.businessId)),
    listOutlets(db, ctx),
  ])
  const active = outlets.filter((o) => o.active)
  const filter = await readOutletFilter(active.map((o) => o.id))

  return (
    <AppShell
      nav="admin"
      context={business?.name ?? ''}
      account={{ name: user?.name ?? '', detail: ROLE_LABELS[ctx.role] }}
      toolbar={
        <>
          <OutletFilter
            outlets={active.map((o) => ({ id: o.id, code: o.code, name: o.name }))}
            value={filter}
            allLabel={ctx.outletScope === 'all' ? 'All outlets' : 'All my outlets'}
          />
          <Link href="/till" aria-label="Open till" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            <ShoppingCart aria-hidden />
            <span className="hidden sm:inline">Open till</span>
          </Link>
        </>
      }
    >
      {children}
    </AppShell>
  )
}
