import { Suspense } from 'react'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { businesses } from '@/db/schema'
import { can } from '@/domain/permissions'
import { listOutlets } from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'
import { CreateOutletForm, DefaultModeForm, MODE_LABELS, OutletRow } from './outlet-forms'

export default function OutletsPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Outlets</h1>
      <Suspense fallback={<p className="mt-4 text-sm text-muted-foreground">Loading…</p>}>
        <OutletsContent />
      </Suspense>
    </>
  )
}

async function OutletsContent() {
  const ctx = await requireTenant()
  const outlets = await listOutlets(db, ctx)
  const canManage = can(ctx.role, 'outlet.manage')
  const [business] = await db
    .select({ mode: businesses.defaultConnectionMode })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))

  return (
    <div className="mt-4 flex flex-col gap-8">
      {canManage && business && (
        <section aria-labelledby="default-heading" className="flex flex-col gap-3">
          <h2 id="default-heading" className="text-lg font-medium">
            Connection mode
          </h2>
          <DefaultModeForm current={business.mode} />
        </section>
      )}

      <section aria-labelledby="list-heading" className="flex flex-col gap-3">
        <h2 id="list-heading" className="text-lg font-medium">
          Your outlets
        </h2>
        {outlets.length === 0 && <p className="text-sm text-muted-foreground">No outlets yet.</p>}
        {outlets.map((o) =>
          canManage ? (
            <OutletRow key={o.id} outlet={o} />
          ) : (
            <div key={o.id} className="rounded-lg border p-3 text-sm">
              <span className="font-mono">{o.code}</span> · {o.name} · {MODE_LABELS[o.effectiveMode]}
            </div>
          ),
        )}
      </section>

      {canManage && (
        <section aria-labelledby="create-heading" className="flex flex-col gap-3">
          <h2 id="create-heading" className="text-lg font-medium">
            Add an outlet
          </h2>
          <CreateOutletForm />
        </section>
      )}
    </div>
  )
}
