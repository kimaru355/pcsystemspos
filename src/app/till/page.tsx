import { Suspense } from 'react'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { businesses } from '@/db/schema'
import { getCurrentUser } from '@/server/auth/current-user'
import { listOutlets } from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'
import { SAMPLE_ITEMS, SAMPLE_ORDER } from './sample'
import { TillWorkspace } from './till-workspace'

export default function TillPage({ searchParams }: PageProps<'/till'>) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh flex-1 flex-col">
          <div className="h-12 bg-rail" />
          <p className="p-6 text-sm text-muted-foreground">Opening the till…</p>
        </div>
      }
    >
      <TillContent searchParams={searchParams} />
    </Suspense>
  )
}

async function TillContent({ searchParams }: { searchParams: PageProps<'/till'>['searchParams'] }) {
  const ctx = await requireTenant()
  const [user, [business], outlets, params] = await Promise.all([
    getCurrentUser(),
    db.select({ name: businesses.name }).from(businesses).where(eq(businesses.id, ctx.businessId)),
    listOutlets(db, ctx),
    searchParams,
  ])
  const active = outlets.filter((o) => o.active)
  // Sample data never reaches a production till.
  const preview = process.env.NODE_ENV !== 'production' && params.preview === '1'

  return (
    <TillWorkspace
      business={business?.name ?? ''}
      cashier={user?.name ?? ''}
      canOpenAdmin={ctx.role !== 'cashier'}
      outlets={active.map((o) => ({ id: o.id, code: o.code, name: o.name }))}
      items={preview ? SAMPLE_ITEMS : []}
      order={preview ? SAMPLE_ORDER : null}
      preview={preview}
    />
  )
}
