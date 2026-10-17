import { Suspense } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { formatKes, formatQty } from '@/domain/money'
import { can } from '@/domain/permissions'
import { TAX_LABELS } from '@/domain/tax'
import { DomainError } from '@/server/errors'
import { getItem, type Item } from '@/server/services/items'
import { itemStockByOutlet } from '@/server/services/stock'
import { listBrands, listCategories, listGroups } from '@/server/services/taxonomy'
import { requireTenant, type TenantCtx } from '@/server/tenant'
import { AddBarcodeForm, RemoveBarcodeForm } from '../barcode-forms'
import { buildCategoryTree } from '../category-tree'
import { ItemForm } from '../item-forms'
import { AddPackForm, PackList } from '../pack-forms'
import { StatusBadge } from '../status-badge'

export default function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Item" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <ItemContent params={params} />
    </Suspense>
  )
}

async function ItemContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await requireTenant()
  let item: Item
  try {
    item = await getItem(db, ctx, id)
  } catch (e) {
    if (e instanceof DomainError && e.code === 'not_found') notFound()
    throw e
  }
  const canManage = can(ctx.role, 'catalog.manage')
  const [categories, brands, groups] = await Promise.all([
    listCategories(db, ctx),
    listBrands(db, ctx),
    listGroups(db, ctx),
  ])
  const group = groups.find((g) => g.id === item.groupId)
  const category = categories.find((c) => c.id === item.categoryId)
  const parent = category?.parentId ? categories.find((c) => c.id === category.parentId) : undefined
  const brand = brands.find((b) => b.id === item.brandId)

  return (
    <>
      <PageHeader
        title={item.name}
        description={
          <>
            {item.sku && <span className="font-mono">{item.sku} · </span>}
            <StatusBadge active={item.active} />
          </>
        }
        actions={
          <Link href="/admin/items" className="text-sm text-primary underline-offset-4 hover:underline">
            All items
          </Link>
        }
      />

      <div className="flex flex-col gap-10">
        <Region id="details-heading" title="Details">
          {canManage ? (
            <ItemForm
              item={item}
              categories={buildCategoryTree(categories, { keep: [item.categoryId] })}
              brands={brands.filter((b) => b.active || b.id === item.brandId)}
              groups={groups.filter((g) => g.active || g.id === item.groupId)}
            />
          ) : (
            <Details
              item={item}
              group={group?.name}
              category={category ? [parent?.name, category.name].filter(Boolean).join(' / ') : undefined}
              brand={brand?.name}
            />
          )}
        </Region>

        <Region
          id="packs-heading"
          title="Packs"
          aside={<span className="text-xs text-muted-foreground">Ways to sell more than one {item.baseUnit} at a time</span>}
        >
          {canManage ? (
            <>
              <PackList item={item} />
              <AddPackForm item={item} />
            </>
          ) : (
            <Packs item={item} />
          )}
        </Region>

        <Region id="barcodes-heading" title="Barcodes">
          <Barcodes item={item} canManage={canManage} />
          {canManage && <AddBarcodeForm item={item} />}
        </Region>

        <Region id="stock-heading" title="Stock by outlet">
          <StockByOutlet ctx={ctx} item={item} />
        </Region>
      </div>
    </>
  )
}

function Details({
  item,
  group,
  category,
  brand,
}: {
  item: Item
  group?: string
  category?: string
  brand?: string
}) {
  const rows: [string, React.ReactNode][] = [
    ['Group', group ?? 'None'],
    ...Object.entries(item.attributes).map(([k, v]): [string, React.ReactNode] => [k.replace(/_/g, ' '), v]),
    ['Category', category ?? 'None'],
    ['Brand', brand ?? 'None'],
    ['SKU', item.sku ? <span key="sku" className="font-mono">{item.sku}</span> : 'None'],
    ['Base unit', `${item.baseUnit}${item.fractional ? ' (sold in fractions)' : ''}`],
    ['Price', <span key="p" className="figures font-semibold">{formatKes(item.priceCents)}</span>],
    ['Lowest price', <span key="f" className="figures">{formatKes(item.floorCents)}</span>],
    ['Tax category', TAX_LABELS[item.taxCategory]],
    [
      'Low stock level',
      item.lowStockMilli === null ? 'None' : (
        <span key="l" className="figures">
          {formatQty(item.lowStockMilli)} {item.baseUnit}
        </span>
      ),
    ],
  ]
  return (
    <dl className="grid gap-x-6 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 border-b border-rule py-2">
          <dt className="text-muted-foreground capitalize">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Packs({ item }: { item: Item }) {
  if (item.packs.length === 0) return <p className="py-2 text-sm text-muted-foreground">No packs.</p>
  return (
    <ul>
      {item.packs.map((p) => (
        <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-rule py-2 text-sm">
          <span className="font-medium">
            {p.name}
            {!p.active && <span className="font-normal text-muted-foreground"> (inactive)</span>}
          </span>
          <span className="figures text-muted-foreground">
            {formatQty(p.baseQtyMilli)} {item.baseUnit} · <span className="font-semibold text-foreground">{formatKes(p.priceCents)}</span>{' '}
            · lowest {formatKes(p.floorCents)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Barcodes({ item, canManage }: { item: Item; canManage: boolean }) {
  if (item.barcodes.length === 0) return <p className="py-2 text-sm text-muted-foreground">No barcodes.</p>
  const packName = new Map(item.packs.map((p) => [p.id, p.name]))
  return (
    <ul>
      {item.barcodes.map((b) => (
        <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule py-1.5 text-sm">
          <span className="min-w-40 font-mono text-[0.8rem] font-medium">{b.barcode}</span>
          <span className="text-muted-foreground">
            {b.packId ? `Pack: ${packName.get(b.packId) ?? 'unknown'}` : `Base unit (${item.baseUnit})`}
          </span>
          {canManage && (
            <div className="ml-auto">
              <RemoveBarcodeForm itemId={item.id} barcodeId={b.id} code={b.barcode} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

async function StockByOutlet({ ctx, item }: { ctx: TenantCtx; item: Item }) {
  const rows = await itemStockByOutlet(db, ctx, item.id)
  if (rows.length === 0) return <p className="py-2 text-sm text-muted-foreground">No outlets to show.</p>
  const canAct = can(ctx.role, 'stock.receive') || can(ctx.role, 'stock.adjust')
  return (
    <ul>
      {rows.map((r) => (
        <li
          key={r.outletId}
          className="grid grid-cols-[4rem_minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 border-b border-rule py-2 text-sm sm:grid-cols-[4rem_minmax(0,1fr)_9rem_6rem_auto]"
        >
          <span className="font-mono text-[0.8rem] font-medium">{r.outletCode}</span>
          <span className="truncate">{r.outletName}</span>
          <span className="figures text-right font-semibold sm:order-none">
            {formatQty(r.onHandMilli)} {item.baseUnit}
          </span>
          <span
            className={`text-xs sm:text-sm ${r.negative ? 'text-credit' : r.isLow ? 'text-owed-ink' : 'text-muted-foreground'}`}
          >
            {r.negative ? 'Negative' : r.isLow ? 'Low' : ''}
          </span>
          <Link
            href={`/admin/stock?outlet=${r.outletId}`}
            className="col-span-3 text-primary underline-offset-4 hover:underline sm:col-span-1 sm:text-right"
          >
            {canAct ? 'Receive or adjust' : 'View stock'}
          </Link>
        </li>
      ))}
    </ul>
  )
}
