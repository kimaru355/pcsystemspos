import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { listCategories } from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { buildCategoryTree } from '../category-tree'
import { ItemsNav } from '../items-nav'
import { StatusBadge } from '../status-badge'
import { CategoryRow, CreateCategoryForm } from '../taxonomy-forms'

export default function CategoriesPage() {
  return (
    <>
      <PageHeader title="Categories" description="Two levels at most: a category and its subcategories." />
      <ItemsNav current="categories" />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <CategoriesContent />
      </Suspense>
    </>
  )
}

async function CategoriesContent() {
  const ctx = await requireTenant()
  const canManage = can(ctx.role, 'catalog.manage')
  const categories = await listCategories(db, ctx)
  const byId = new Map(categories.map((c) => [c.id, c]))
  const tree = buildCategoryTree(categories, { includeInactive: true })
  // Only top-level categories can be a parent.
  const parents = tree.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name }))

  return (
    <div className="flex flex-col gap-10">
      <Region id="categories-heading" title="Your categories">
        {tree.length === 0 && <p className="py-2 text-sm text-muted-foreground">No categories yet.</p>}
        <div>
          {tree.map((c) => (
            <div key={c.id}>
              {canManage ? (
                <CategoryRow category={byId.get(c.id)!} parents={parents} hasChildren={c.children.length > 0} depth={0} />
              ) : (
                <ReadOnlyLine name={c.name} active={c.active} depth={0} />
              )}
              {c.children.map((k) =>
                canManage ? (
                  <CategoryRow key={k.id} category={byId.get(k.id)!} parents={parents} hasChildren={false} depth={1} />
                ) : (
                  <ReadOnlyLine key={k.id} name={k.name} active={k.active} depth={1} />
                ),
              )}
            </div>
          ))}
        </div>
      </Region>

      {canManage && (
        <Region id="add-category-heading" title="Add a category">
          <CreateCategoryForm parents={parents} />
        </Region>
      )}
    </div>
  )
}

function ReadOnlyLine({ name, active, depth }: { name: string; active: boolean; depth: 0 | 1 }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 border-b border-rule py-2 text-sm ${depth === 1 ? 'pl-6' : 'font-medium'}`}>
      <span>{name}</span>
      {!active && <StatusBadge active={false} />}
    </div>
  )
}
