import type { Db } from '@/db/client'
import { formatAmount, formatQty } from '@/domain/money'
import { listOutlets } from '@/server/services/outlets'
import { paymentsByMethod, salesByCashier, salesByDay, salesByItem, salesByOutlet, type Range, type ReportScope } from '@/server/services/reports'
import { listStock } from '@/server/services/stock'
import type { TenantCtx } from '@/server/tenant'

/* The reports as tables (header + rows of text), shared by the page and the CSV export. */

export const REPORTS = {
  sales_by_day: 'Sales by day',
  sales_by_outlet: 'Sales by outlet',
  sales_by_item: 'Sales by item',
  sales_by_cashier: 'Sales by cashier',
  payments_by_method: 'Payments by method',
  stock_on_hand: 'Stock on hand',
} as const

export type ReportKey = keyof typeof REPORTS

export function isReportKey(v: string): v is ReportKey {
  return Object.hasOwn(REPORTS, v)
}

export type Table = { header: string[]; rows: string[][]; numeric: boolean[] }

const METHOD: Record<string, string> = { cash: 'Cash', mpesa: 'M-Pesa', mark_paid: 'Marked paid', other: 'Other' }

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' })

/** `YYYY-MM-DD` in Nairobi → that midnight (UTC+3 all year); null when malformed. */
export function nairobiDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 3 * 60 * 60 * 1000)
  return Number.isNaN(d.getTime()) ? null : d
}

export function dayString(d: Date): string {
  return dayKey.format(d)
}

/** The range from the query: `from` and `to` days, both included; the last 7 days by default. */
export function rangeFrom(from: string, to: string): { range: Range; from: string; to: string } {
  const today = dayString(new Date())
  const t = nairobiDay(to) ? to : today
  const f = nairobiDay(from) ? from : dayString(new Date(nairobiDay(t)!.getTime() - 6 * 24 * 60 * 60 * 1000))
  return { range: { from: nairobiDay(f)!, to: new Date(nairobiDay(t)!.getTime() + 24 * 60 * 60 * 1000) }, from: f, to: t }
}

export async function reportTable(db: Db, ctx: TenantCtx, key: ReportKey, range: Range, scope: ReportScope): Promise<Table> {
  switch (key) {
    case 'sales_by_day':
    case 'sales_by_outlet':
    case 'sales_by_cashier': {
      const fn = key === 'sales_by_day' ? salesByDay : key === 'sales_by_outlet' ? salesByOutlet : salesByCashier
      const rows = await fn(db, ctx, range, scope)
      const first = key === 'sales_by_day' ? 'Day' : key === 'sales_by_outlet' ? 'Outlet' : 'Cashier'
      return {
        header: [first, 'Orders', 'Sales (KES)', 'VAT (KES)'],
        numeric: [false, true, true, true],
        rows: rows.map((r) => [
          key === 'sales_by_outlet' ? `${r.key} ${r.label}` : r.label,
          String(r.orders),
          formatAmount(r.grossCents),
          formatAmount(r.vatCents),
        ]),
      }
    }
    case 'sales_by_item': {
      const rows = await salesByItem(db, ctx, range, scope)
      return {
        header: ['Item', 'Quantity', 'Unit', 'Sales (KES)'],
        numeric: [false, true, false, true],
        rows: rows.map((r) => [r.name, formatQty(r.qtyMilli), r.unit, formatAmount(r.grossCents)]),
      }
    }
    case 'payments_by_method': {
      const rows = await paymentsByMethod(db, ctx, range, scope)
      return {
        header: ['Method', 'Payments', 'Amount (KES)'],
        numeric: [false, true, true],
        rows: rows.map((r) => [`${r.kind === 'refund' ? 'Refunds by ' : ''}${METHOD[r.method] ?? r.method}`, String(r.count), formatAmount(r.amountCents)]),
      }
    }
    case 'stock_on_hand': {
      const outlets = (await listOutlets(db, ctx)).filter((o) => o.active && (!scope.outletId || o.id === scope.outletId))
      const rows: string[][] = []
      for (const o of outlets) {
        for (const r of await listStock(db, ctx, o.id)) {
          rows.push([o.code, r.itemName, r.sku ?? '', r.baseUnit, formatQty(r.onHandMilli), formatQty(r.owedMilli), formatQty(r.availableMilli)])
        }
      }
      return {
        header: ['Outlet', 'Item', 'SKU', 'Unit', 'On hand', 'Owed', 'Available'],
        numeric: [false, false, false, false, true, true, true],
        rows,
      }
    }
  }
}
