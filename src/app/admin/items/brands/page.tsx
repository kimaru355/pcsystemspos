import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { listBrands } from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { ItemsNav } from '../items-nav'
import { StatusBadge } from '../status-badge'
import { BrandRow, CreateBrandForm } from '../taxonomy-forms'

export default function BrandsPage() {
  return (
    <>
      <PageHeader title="Brands" />
      <ItemsNav current="brands" />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <BrandsContent />
      </Suspense>
    </>
  )
}

async function BrandsContent() {
  const ctx = await requireTenant()
  const canManage = can(ctx.role, 'catalog.manage')
  const brands = await listBrands(db, ctx)
  return (
    <div className="flex flex-col gap-10">
      <Region id="brands-heading" title="Your brands">
        {brands.length === 0 && <p className="py-2 text-sm text-muted-foreground">No brands yet.</p>}
        {brands.map((b) =>
          canManage ? (
            <BrandRow key={b.id} brand={b} />
          ) : (
            <div key={b.id} className="flex items-baseline justify-between gap-4 border-b border-rule py-2 text-sm">
              <span>{b.name}</span>
              {!b.active && <StatusBadge active={false} />}
            </div>
          ),
        )}
      </Region>
      {canManage && (
        <Region id="add-brand-heading" title="Add a brand">
          <CreateBrandForm />
        </Region>
      )}
    </div>
  )
}
