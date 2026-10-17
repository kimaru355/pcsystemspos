import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { listBrands, listCategories, listGroups } from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { buildCategoryTree } from '../category-tree'
import { ItemsNav } from '../items-nav'
import { StatusBadge } from '../status-badge'
import { CreateGroupForm, GroupRow } from '../taxonomy-forms'

export default function GroupsPage() {
  return (
    <>
      <PageHeader
        title="Groups"
        description="A group is a family of items that share detail fields, like size or colour."
      />
      <ItemsNav current="groups" />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <GroupsContent />
      </Suspense>
    </>
  )
}

async function GroupsContent() {
  const ctx = await requireTenant()
  const canManage = can(ctx.role, 'catalog.manage')
  const [groups, categories, brands] = await Promise.all([
    listGroups(db, ctx),
    listCategories(db, ctx),
    listBrands(db, ctx),
  ])
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  const brandName = new Map(brands.map((b) => [b.id, b.name]))
  const activeBrands = brands.filter((b) => b.active)
  const refsFor = (keepCategory: string | null, keepBrand: string | null) => ({
    categories: buildCategoryTree(categories, { keep: [keepCategory] }),
    brands: brands.filter((b) => b.active || b.id === keepBrand),
  })

  return (
    <div className="flex flex-col gap-10">
      <Region id="groups-heading" title="Your groups">
        {groups.length === 0 && <p className="py-2 text-sm text-muted-foreground">No groups yet.</p>}
        {groups.map((g) =>
          canManage ? (
            <GroupRow key={g.id} group={g} refs={refsFor(g.categoryId, g.brandId)} />
          ) : (
            <div key={g.id} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-rule py-2 text-sm">
              <span className="font-medium">{g.name}</span>
              <span className="text-muted-foreground">
                {[
                  g.categoryId ? categoryName.get(g.categoryId) : null,
                  g.brandId ? brandName.get(g.brandId) : null,
                  g.attributeKeys.length > 0 ? `Fields: ${g.attributeKeys.join(', ')}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {!g.active && <StatusBadge active={false} />}
            </div>
          ),
        )}
      </Region>
      {canManage && (
        <Region id="add-group-heading" title="Add a group">
          <CreateGroupForm refs={{ categories: buildCategoryTree(categories), brands: activeBrands }} />
        </Region>
      )}
    </div>
  )
}
