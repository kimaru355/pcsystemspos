import { Suspense } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/shell/page-header'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { listBrands, listCategories, listGroups } from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { buildCategoryTree } from '../category-tree'
import { ItemForm } from '../item-forms'

export default function NewItemPage() {
  return (
    <>
      <PageHeader title="New item" />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <NewItemContent />
      </Suspense>
    </>
  )
}

async function NewItemContent() {
  const ctx = await requireTenant()
  if (!can(ctx.role, 'catalog.manage')) {
    return (
      <p className="text-sm text-muted-foreground">
        Only owners can add items.{' '}
        <Link href="/admin/items" className="text-primary underline-offset-4 hover:underline">
          Back to items
        </Link>
      </p>
    )
  }
  const [categories, brands, groups] = await Promise.all([
    listCategories(db, ctx),
    listBrands(db, ctx),
    listGroups(db, ctx),
  ])
  return (
    <div className="flex flex-col gap-4">
      <Link href="/admin/items" className="w-fit text-sm text-primary underline-offset-4 hover:underline">
        All items
      </Link>
      <ItemForm
        categories={buildCategoryTree(categories)}
        brands={brands.filter((b) => b.active)}
        groups={groups.filter((g) => g.active)}
      />
    </div>
  )
}
