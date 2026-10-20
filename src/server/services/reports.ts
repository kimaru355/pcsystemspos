import { sql, type SQL } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { isUuid } from '@/domain/ids'
import type { Cents, Milli } from '@/domain/money'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'

/*
 * Reports and dashboard figures, summed in SQL. Line values follow the domain's rounding:
 * a line is round((qty − cancelled) × unit price / 1000) cents, its VAT
 * round(gross × rate / (10000 + rate)); paid is payments less refunds.
 */

export type Range = { from: Date; to: Date }
export type ReportScope = { outletId: string | null }

/** Orders the caller may see, optionally one outlet. */
function orderScope(ctx: TenantCtx, f: ReportScope, alias = 'o'): SQL {
  const parts: SQL[] = [sql.raw(`${alias}.business_id = `).append(sql`${ctx.businessId}`)]
  if (ctx.outletScope !== 'all') {
    parts.push(sql.raw(`${alias}.outlet_id = any(`).append(sql`${sql.param(ctx.outletScope)}::uuid[])`))
  }
  if (f.outletId) parts.push(sql.raw(`${alias}.outlet_id = `).append(sql`${f.outletId}`))
  return sql.join(parts, sql` and `)
}

function checkScope(ctx: TenantCtx, f: ReportScope) {
  assertCan(ctx, 'report.view')
  if (f.outletId !== null) {
    if (!isUuid(f.outletId)) throw new DomainError('not_found')
    if (ctx.outletScope !== 'all' && !ctx.outletScope.includes(f.outletId)) throw new DomainError('forbidden')
  }
}

const LINE_GROSS = sql.raw(`round(((l.qty_milli - l.cancelled_milli) * l.unit_price_cents)::numeric / 1000)`)
const LINE_VAT = sql.raw(
  `round(round(((l.qty_milli - l.cancelled_milli) * l.unit_price_cents)::numeric / 1000) * l.vat_rate_bp / (10000 + l.vat_rate_bp))`,
)
const IN_RANGE = (r: Range) => sql`o.occurred_at >= ${r.from} and o.occurred_at < ${r.to}`

const n = (v: unknown) => Number(v ?? 0)

export type SalesRow = { key: string; label: string; orders: number; grossCents: Cents; vatCents: Cents }

async function salesBy(db: Db, ctx: TenantCtx, r: Range, f: ReportScope, key: SQL, label: SQL, order: SQL): Promise<SalesRow[]> {
  checkScope(ctx, f)
  const { rows } = await db.execute<{ key: string; label: string; orders: string; gross: string; vat: string }>(sql`
    select ${key} as key, ${label} as label, count(distinct o.id) as orders,
           coalesce(sum(${LINE_GROSS}), 0) as gross, coalesce(sum(${LINE_VAT}), 0) as vat
    from orders o
    join order_lines l on l.order_id = o.id
    left join outlets ot on ot.id = o.outlet_id
    left join users u on u.id = o.created_by
    where ${orderScope(ctx, f)} and ${IN_RANGE(r)}
    group by 1, 2
    order by ${order}`)
  return rows.map((x) => ({ key: String(x.key), label: x.label, orders: n(x.orders), grossCents: n(x.gross), vatCents: n(x.vat) }))
}

const DAY = sql.raw(`to_char(o.occurred_at at time zone 'Africa/Nairobi', 'YYYY-MM-DD')`)

export const salesByDay = (db: Db, ctx: TenantCtx, r: Range, f: ReportScope) => salesBy(db, ctx, r, f, DAY, DAY, sql.raw('1'))
export const salesByOutlet = (db: Db, ctx: TenantCtx, r: Range, f: ReportScope) =>
  salesBy(db, ctx, r, f, sql.raw('ot.code'), sql.raw('ot.name'), sql.raw('1'))
export const salesByCashier = (db: Db, ctx: TenantCtx, r: Range, f: ReportScope) =>
  salesBy(db, ctx, r, f, sql.raw('u.id::text'), sql.raw('u.name'), sql.raw('4 desc, 2'))

export type ItemSalesRow = { itemId: string; name: string; unit: string; qtyMilli: Milli; grossCents: Cents }

/** Sold quantity in the item's base unit (packs converted) and value, best sellers first. */
export async function salesByItem(db: Db, ctx: TenantCtx, r: Range, f: ReportScope): Promise<ItemSalesRow[]> {
  checkScope(ctx, f)
  const { rows } = await db.execute<{ item_id: string; name: string; unit: string; qty: string; gross: string }>(sql`
    select i.id as item_id, i.name, i.base_unit as unit,
           sum((l.qty_milli - l.cancelled_milli) * l.base_qty_per_unit_milli / 1000) as qty,
           coalesce(sum(${LINE_GROSS}), 0) as gross
    from orders o
    join order_lines l on l.order_id = o.id
    join items i on i.id = l.item_id
    where ${orderScope(ctx, f)} and ${IN_RANGE(r)}
    group by i.id, i.name, i.base_unit
    order by gross desc, i.name`)
  return rows.map((x) => ({ itemId: x.item_id, name: x.name, unit: x.unit, qtyMilli: n(x.qty), grossCents: n(x.gross) }))
}

export type PaymentMethodRow = { method: string; kind: 'payment' | 'refund'; count: number; amountCents: Cents }

/** Money in (and refunds out) by method, by when it happened. */
export async function paymentsByMethod(db: Db, ctx: TenantCtx, r: Range, f: ReportScope): Promise<PaymentMethodRow[]> {
  checkScope(ctx, f)
  const { rows } = await db.execute<{ method: string; kind: 'payment' | 'refund'; count: string; amount: string }>(sql`
    select p.method, p.kind, count(*) as count, sum(p.amount_cents) as amount
    from payments p
    join orders o on o.id = p.order_id
    where ${orderScope(ctx, f)} and p.occurred_at >= ${r.from} and p.occurred_at < ${r.to}
    group by 1, 2
    order by 2, 4 desc`)
  return rows.map((x) => ({ method: x.method, kind: x.kind, count: n(x.count), amountCents: n(x.amount) }))
}

/** Per-order total, paid and collected value, for the orders in scope. */
const ORDER_FIGURES = (ctx: TenantCtx, f: ReportScope) => sql`
  with lines as (
    select o.id, o.customer_id, o.status,
           sum(${LINE_GROSS}) as total,
           sum(round((l.collected_milli * l.unit_price_cents)::numeric / 1000)) as collected
    from orders o join order_lines l on l.order_id = o.id
    where ${orderScope(ctx, f)}
    group by o.id
  ),
  paid as (
    select order_id, sum(case when kind = 'refund' then -amount_cents else amount_cents end) as paid
    from payments where business_id = ${ctx.businessId} group by order_id
  ),
  figures as (
    select lines.*, coalesce(paid.paid, 0) as paid from lines left join paid on paid.order_id = lines.id
  )`

export type MoneyOwed = { openOrders: number; owedCents: Cents; creditCents: Cents }

/** Money still owed on open orders, and goods handed over beyond what was paid (credit owed). */
export async function moneyOwed(db: Db, ctx: TenantCtx, f: ReportScope): Promise<MoneyOwed> {
  checkScope(ctx, f)
  const { rows } = await db.execute<{ open: string; owed: string; credit: string }>(sql`
    ${ORDER_FIGURES(ctx, f)}
    select count(*) filter (where status = 'open') as open,
           coalesce(sum(greatest(total - paid, 0)) filter (where status = 'open'), 0) as owed,
           coalesce(sum(greatest(collected - paid, 0)), 0) as credit
    from figures`)
  return { openOrders: n(rows[0]?.open), owedCents: n(rows[0]?.owed), creditCents: n(rows[0]?.credit) }
}

export type SalesSummary = { orders: number; totalCents: Cents; paidCents: Cents; collectedValueCents: Cents; owedCents: Cents }

/** Orders taken in the range, summed (the overview's money and goods bar). */
export async function salesSummary(db: Db, ctx: TenantCtx, r: Range, f: ReportScope): Promise<SalesSummary> {
  checkScope(ctx, f)
  const { rows } = await db.execute<{ orders: string; total: string; paid: string; collected: string; owed: string }>(sql`
    ${ORDER_FIGURES(ctx, f)}
    select count(*) as orders, coalesce(sum(total), 0) as total, coalesce(sum(paid), 0) as paid,
           coalesce(sum(collected), 0) as collected, coalesce(sum(greatest(total - paid, 0)), 0) as owed
    from figures join orders o on o.id = figures.id
    where ${IN_RANGE(r)}`)
  const x = rows[0]
  return { orders: n(x?.orders), totalCents: n(x?.total), paidCents: n(x?.paid), collectedValueCents: n(x?.collected), owedCents: n(x?.owed) }
}

export type CustomerRow = {
  id: string
  name: string
  phone: string
  orders: number
  owedCents: Cents
  creditCents: Cents
  lastOrderAt: Date | null
}

/** Customers with orders in scope: what they owe on open orders and for goods taken on credit. */
export async function listCustomers(
  db: Db,
  ctx: TenantCtx,
  q: { search?: string; owingOnly?: boolean; id?: string } = {},
): Promise<CustomerRow[]> {
  checkScope(ctx, { outletId: null })
  const term = q.search?.trim().toLowerCase() ?? ''
  const digits = term.replace(/\D/g, '').replace(/^0/, '')
  const { rows } = await db.execute<{
    id: string
    name: string
    phone: string
    orders: string
    owed: string
    credit: string
    last: Date | null
  }>(sql`
    ${ORDER_FIGURES(ctx, { outletId: null })}
    select c.id, c.name, c.phone, count(f.id) as orders,
           coalesce(sum(greatest(f.total - f.paid, 0)) filter (where f.status = 'open'), 0) as owed,
           coalesce(sum(greatest(f.collected - f.paid, 0)), 0) as credit,
           max(o.occurred_at) as last
    from customers c
    join figures f on f.customer_id = c.id
    join orders o on o.id = f.id
    where c.business_id = ${ctx.businessId}
      ${q.id ? sql`and c.id = ${q.id}` : sql``}
      ${term ? sql`and (lower(c.name) like ${`%${term.replace(/[\\%_]/g, '\\$&')}%`} ${digits.length >= 3 ? sql`or c.phone like ${`%${digits}%`}` : sql``})` : sql``}
    group by c.id
    ${q.owingOnly ? sql`having sum(greatest(f.total - f.paid, 0)) filter (where f.status = 'open') > 0 or sum(greatest(f.collected - f.paid, 0)) > 0` : sql``}
    order by credit desc, owed desc, last desc nulls last
    limit 500`)
  return rows.map((x) => ({
    id: x.id,
    name: x.name,
    phone: x.phone,
    orders: n(x.orders),
    owedCents: n(x.owed),
    creditCents: n(x.credit),
    lastOrderAt: x.last ? new Date(x.last) : null,
  }))
}

export async function getCustomer(db: Db, ctx: TenantCtx, id: string): Promise<CustomerRow> {
  if (!isUuid(id)) throw new DomainError('not_found')
  const [c] = await listCustomers(db, ctx, { id })
  if (!c) throw new DomainError('not_found')
  return c
}

/** Counts for the overview: unmatched M-Pesa payments and items below zero in scope. */
export async function attentionCounts(db: Db, ctx: TenantCtx, f: ReportScope): Promise<{ unmatched: number; negative: number }> {
  checkScope(ctx, f)
  const { rows } = await db.execute<{ unmatched: string; negative: string }>(sql`
    select
      (select count(*) from mpesa_transactions t where t.business_id = ${ctx.businessId} and t.status = 'unmatched') as unmatched,
      (select count(*) from outlet_stock s
        where ${orderScope(ctx, f, 's')} and s.on_hand_milli < 0) as negative`)
  return { unmatched: n(rows[0]?.unmatched), negative: n(rows[0]?.negative) }
}
