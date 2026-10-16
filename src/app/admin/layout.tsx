import { Suspense } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { businesses } from '@/db/schema'
import { Button } from '@/components/ui/button'
import { requireTenant } from '@/server/tenant'
import { logout } from '../logout/actions'

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/outlets', label: 'Outlets' },
  { href: '/admin/staff', label: 'Staff' },
] as const

export default function AdminLayout({ children }: LayoutProps<'/admin'>) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading…</p>}>
      <AdminShell>{children}</AdminShell>
    </Suspense>
  )
}

/** Owners and managers only; cashiers belong at the till. */
async function AdminShell({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenant()
  if (ctx.role === 'cashier') redirect('/till')
  const [business] = await db
    .select({ name: businesses.name })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3">
        <span className="font-semibold">{business?.name}</span>
        <nav aria-label="Admin" className="flex flex-1 gap-4 text-sm">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="hover:underline">
              {item.label}
            </Link>
          ))}
        </nav>
        <form action={logout}>
          <Button type="submit" variant="outline" size="sm">
            Log out
          </Button>
        </form>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 p-4">{children}</main>
    </div>
  )
}
