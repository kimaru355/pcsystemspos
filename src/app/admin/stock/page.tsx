import { Suspense } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { isUuid } from '@/domain/ids'
import { formatQty } from '@/domain/money'
import { can } from '@/domain/permissions'
import { listOutlets } from '@/server/services/outlets'
import { listStock } from '@/server/services/stock'
import { listCategories } from '@/server/services/taxonomy'
import { requireTenant } from '@/server/tenant'
import { inputClass } from '../_forms/styles'
import { buildCategoryTree } from '../items/category-tree'
import { CategoryOptions } from '../items/item-forms'
import { one, pickOutlet } from './outlet-param'
import { StockRowActions } from './stock-forms'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

const ROW_CAP = 200
const COLUMNS = 'xl:grid-cols-[minmax(10rem,1fr)_6.5rem_6.5rem_6.5rem_5.5rem_12rem]'

export default function StockPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Stock" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <StockContent searchParams={searchParams} />
    </Suspense>
  )
}

async function StockContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const ctx = await requireTenant()
  const active = (await listOutlets(db, ctx)).filter((o) => o.active)
  const outlet = pickOutlet(active, one(params.outlet))

  if (!outlet) {
    return (
      <>
        <PageHeader title="Stock" description="What is on the shelf at each outlet." />
        <p className="py-3 text-sm text-muted-foreground">
          {ctx.outletScope === 'all'
            ? 'There are no open outlets yet. Open an outlet to start tracking stock.'
            : 'You are not assigned to an outlet yet. Ask the owner.'}
        </p>
        {ctx.outletScope === 'all' && (
          <Link href="/admin/outlets" className="text-sm text-primary underline-offset-4 hover:underline">
            Go to outlets
          </Link>
        )}
      </>
    )
  }

  const q = one(params.q).trim()
  const category = one(params.category)
  const lowOnly = one(params.low) === '1'
  const negativeOnly = one(params.negative) === '1'
  const canReceive = can(ctx.role, 'stock.receive')
  const canAdjust = can(ctx.role, 'stock.adjust')

  const [rows, categories] = await Promise.all([
    listStock(db, ctx, outlet.id, {
      search: q || undefined,
      categoryId: isUuid(category) ? category : undefined,
      lowOnly,
      negativeOnly,
    }),
    listCategories(db, ctx),
  ])
  const tree = buildCategoryTree(categories, { keep: [category] })
  const shown = rows.slice(0, ROW_CAP)
  const filtered = q !== '' || category !== '' || lowOnly || negativeOnly

  return (
    <>
      <PageHeader title="Stock" description={`${outlet.code} · ${outlet.name}. What is on the shelf, and what is running low.`} />

      <form method="get" role="search" className="grid gap-3 pb-6 sm:grid-cols-2 xl:grid-cols-[12rem_minmax(0,1fr)_14rem_auto] xl:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="stock-outlet" className="text-sm font-medium">
            Outlet
          </label>
          <select id="stock-outlet" name="outlet" defaultValue={outlet.id} className={inputClass}>
            {active.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="stock-q" className="text-sm font-medium">
            Search
          </label>
          <input id="stock-q" name="q" type="search" defaultValue={q} placeholder="Name, SKU or barcode" className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="stock-category" className="text-sm font-medium">
            Category
          </label>
          <select id="stock-category" name="category" defaultValue={category} className={inputClass}>
            <CategoryOptions tree={tree} empty="All categories" />
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-2 xl:col-span-1 xl:h-9">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="low" value="1" defaultChecked={lowOnly} />
            Low only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="negative" value="1" defaultChecked={negativeOnly} />
            Negative only
          </label>
        </div>
        <div className="flex items-center gap-3 sm:col-span-2 xl:col-span-4">
          <Button type="submit" variant="outline" size="lg">
            Filter
          </Button>
          {filtered && (
            <Link href={`/admin/stock?outlet=${outlet.id}`} className="text-sm text-primary underline-offset-4 hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      <Region
        id="stock-heading"
        title={filtered ? 'Matching items' : `Stock at ${outlet.code}`}
        aside={
          <span className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </span>
        }
      >
        {rows.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {filtered ? 'No items match.' : 'No active items yet. Add items first, then receive stock here.'}
          </p>
        ) : (
          <>
            <div
              aria-hidden
              className={`hidden items-baseline gap-x-3 border-b border-rule py-1.5 text-xs font-medium text-muted-foreground xl:grid ${COLUMNS}`}
            >
              <span>Item</span>
              <span className="text-right">On hand</span>
              <span className="text-right">Available</span>
              <span className="text-right">Low at</span>
              <span>Status</span>
              <span />
            </div>
            <ul>
              {shown.map((r) => {
                const unit = r.baseUnit
                const status = r.negative ? 'Negative' : r.isLow ? 'Low' : ''
                const tone = r.negative ? 'text-credit' : 'text-owed-ink'
                return (
                  <li
                    key={r.itemId}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 border-b border-rule py-2 text-sm xl:min-h-9 ${COLUMNS}`}
                  >
                    <span className="min-w-0">
                      <Link
                        href={`/admin/stock/${r.itemId}?outlet=${outlet.id}`}
                        className="font-medium break-words text-primary underline-offset-4 hover:underline"
                      >
                        {r.itemName}
                      </Link>
                      {r.sku && <span className="ml-2 font-mono text-[0.8rem] text-muted-foreground">{r.sku}</span>}
                    </span>
                    <span className="figures text-right font-semibold">
                      {formatQty(r.onHandMilli)} <span className="font-normal text-muted-foreground">{unit}</span>
                    </span>
                    <span className="figures col-span-2 text-xs text-muted-foreground xl:hidden">
                      Available {formatQty(r.availableMilli)} {unit}
                      {r.lowStockMilli !== null && ` · Low at ${formatQty(r.lowStockMilli)}`}
                      {status && (
                        <>
                          {' · '}
                          <span className={`font-medium ${tone}`}>{status}</span>
                        </>
                      )}
                    </span>
                    <span className="figures hidden text-right xl:block">{formatQty(r.availableMilli)}</span>
                    <span className="figures hidden text-right text-muted-foreground xl:block">
                      {r.lowStockMilli === null ? '' : formatQty(r.lowStockMilli)}
                    </span>
                    <span className={`hidden font-medium xl:block ${tone}`}>{status}</span>
                    <StockRowActions
                      target={{ outletId: outlet.id, itemId: r.itemId, baseUnit: unit, fractional: r.fractional }}
                      canReceive={canReceive}
                      canAdjust={canAdjust}
                    />
                  </li>
                )
              })}
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
