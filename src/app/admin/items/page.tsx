import { Suspense } from 'react'
import Link from 'next/link'
import { buttonVariants, Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { isUuid } from '@/domain/ids'
import { formatKes } from '@/domain/money'
import { can } from '@/domain/permissions'
import { listItems } from '@/server/services/items'
import { listCategories } from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { buildCategoryTree } from './category-tree'
import { CategoryOptions } from './item-forms'
import { ItemsNav } from './items-nav'
import { StatusBadge } from './status-badge'
import { inputClass } from '../_forms/styles'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

const ROW_CAP = 200
const COLUMNS = 'lg:grid-cols-[5.5rem_minmax(9rem,1fr)_7rem_3.5rem_6.5rem_3rem_4.5rem]'

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

export default function ItemsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Items" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <ItemsContent searchParams={searchParams} />
    </Suspense>
  )
}

async function ItemsContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const ctx = await requireTenant()
  const canManage = can(ctx.role, 'catalog.manage')

  const q = one(params.q).trim()
  const category = one(params.category)
  const status = one(params.status)
  const [rows, categories] = await Promise.all([
    listItems(db, ctx, {
      search: q || undefined,
      categoryId: isUuid(category) ? category : undefined,
      active: status === 'active' ? true : status === 'inactive' ? false : undefined,
    }),
    listCategories(db, ctx),
  ])
  const tree = buildCategoryTree(categories, { keep: [category] })
  const shown = rows.slice(0, ROW_CAP)
  const filtered = q !== '' || category !== '' || status !== ''

  return (
    <>
      <PageHeader
        title="Items"
        description="What you sell, its prices, packs and barcodes."
        actions={
          canManage && (
            <>
              <Link href="/admin/items/import" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                Import
              </Link>
              <Link href="/admin/items/new" className={buttonVariants({ size: 'lg' })}>
                New item
              </Link>
            </>
          )
        }
      />
      <ItemsNav current="items" />

      <form method="get" role="search" className="grid gap-3 pb-6 sm:grid-cols-[minmax(0,1fr)_14rem_10rem_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="items-q" className="text-sm font-medium">
            Search
          </label>
          <input
            id="items-q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Name, SKU or barcode"
            className={inputClass}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="items-category" className="text-sm font-medium">
            Category
          </label>
          <select id="items-category" name="category" defaultValue={category} className={inputClass}>
            <CategoryOptions tree={tree} empty="All categories" />
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="items-status" className="text-sm font-medium">
            Status
          </label>
          <select id="items-status" name="status" defaultValue={status} className={inputClass}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="outline" size="lg">
            Filter
          </Button>
          {filtered && (
            <Link href="/admin/items" className="text-sm text-primary underline-offset-4 hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      <Region
        id="items-heading"
        title={filtered ? 'Matching items' : 'All items'}
        aside={
          <span className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {filtered
              ? 'No items match.'
              : canManage
                ? 'No items yet. Add your first item, or import a list.'
                : 'No items yet.'}
          </p>
        ) : (
          <>
            <div
              aria-hidden
              className={`hidden items-baseline gap-x-3 border-b border-rule py-1.5 text-xs font-medium text-muted-foreground lg:grid ${COLUMNS}`}
            >
              <span>SKU</span>
              <span>Name</span>
              <span>Category</span>
              <span>Unit</span>
              <span className="text-right">Price</span>
              <span className="text-right">Packs</span>
              <span>Status</span>
            </div>
            <ul>
              {shown.map((it) => (
                <li
                  key={it.id}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-rule py-2 text-sm lg:min-h-9 ${COLUMNS}`}
                >
                  <span className="hidden font-mono text-[0.8rem] font-medium lg:block">{it.sku ?? ''}</span>
                  <Link
                    href={`/admin/items/${it.id}`}
                    className="min-w-0 font-medium break-words text-primary underline-offset-4 hover:underline"
                  >
                    {it.name}
                  </Link>
                  <span className="hidden break-words lg:block">{it.categoryName ?? ''}</span>
                  <span className="hidden lg:block">{it.baseUnit}</span>
                  <span className="figures text-right font-semibold">{formatKes(it.priceCents)}</span>
                  <span className="figures hidden text-right lg:block">{it.packCount}</span>
                  <span className="hidden lg:block">
                    <StatusBadge active={it.active} />
                  </span>
                  <span className="col-span-2 text-xs text-muted-foreground lg:hidden">
                    {[
                      it.sku,
                      it.categoryName,
                      it.baseUnit,
                      it.packCount > 0 ? `${it.packCount} ${it.packCount === 1 ? 'pack' : 'packs'}` : null,
                      it.active ? null : 'Inactive',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
            {rows.length > shown.length && (
              <p className="py-3 text-sm text-muted-foreground">
                Showing the first {ROW_CAP}. Search or filter to narrow the list.
              </p>
            )}
          </>
        )}
      </Region>
    </>
  )
}
