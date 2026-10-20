import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { getOrder } from '@/server/services/orders'
import {
  attentionCounts,
  getCustomer,
  listCustomers,
  moneyOwed,
  paymentsByMethod,
  salesByCashier,
  salesByDay,
  salesByItem,
  salesByOutlet,
  salesSummary,
} from '@/server/services/reports'
import { applyOp } from '@/server/services/sync'
import { getTenantCtx } from '@/server/tenant'
import { resetDb } from '../helpers/db'
import { adjustOp, checkoutOp, tillWorld, uuid, type TillWorld } from './till-helpers'

const range = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 3600_000) })
const all = { outletId: null }

async function sales(w: TillWorld) {
  // 2 bags cash, all taken.
  const a = checkoutOp(w, { cashCents: 156000 })
  // 1 bundle (20 sheets) at a manager-approved low price, half paid, nothing taken, named customer.
  const b = checkoutOp(w, {
    lines: [
      {
        id: uuid(),
        itemId: w.sheet.id,
        packId: w.bundle.id,
        qtyMilli: 1000,
        unitPriceCents: 1800000,
        listPriceCents: 1800000,
        floorCents: 1750000,
        priceApproverId: null,
      },
    ],
    cashCents: 900000,
    collect: 'none',
    customer: { name: 'Peter Wafula', phone: '0712345678' },
  })
  // 3 bags, 1 paid for, 2 taken on credit approved by the manager.
  const c = checkoutOp(w, {
    lines: [
      { id: uuid(), itemId: w.cement.id, packId: null, qtyMilli: 3000, unitPriceCents: 78000, listPriceCents: 78000, floorCents: 75000, priceApproverId: null },
    ],
    cashCents: 78000,
    collect: [{ lineId: '', qtyMilli: 3000 }],
    creditApproverId: w.manager.membershipId,
    customer: { name: 'Peter Wafula', phone: '0712345678' },
  })
  c.payload.collection!.lines[0].lineId = c.payload.order.lines[0].id
  for (const op of [a, b, c]) expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'applied' })
  return { a, b, c }
}

describe('reports', () => {
  beforeEach(resetDb)

  it('sums sales by day, outlet, cashier and item the same way the orders do', async () => {
    const w = await tillWorld()
    const { a, b, c } = await sales(w)
    const totals = await Promise.all([a, b, c].map((op) => getOrder(db, w.owner, op.payload.order.id)))
    const gross = totals.reduce((s, d) => s + d.figures.totalCents, 0)
    const vat = totals.reduce((s, d) => s + d.figures.vatCents, 0)

    const days = await salesByDay(db, w.owner, range(), all)
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ orders: 3, grossCents: gross, vatCents: vat })
    expect(await salesByOutlet(db, w.owner, range(), all)).toEqual([{ key: 'KTL', label: 'Outlet KTL', orders: 3, grossCents: gross, vatCents: vat }])
    expect((await salesByCashier(db, w.owner, range(), all))[0]).toMatchObject({ label: w.cashier.name, orders: 3 })
    const items = await salesByItem(db, w.owner, range(), all)
    expect(items.map((i) => [i.name, i.qtyMilli])).toEqual([
      ['Iron sheet 30G', 20000],
      ['Cement 50kg', 5000],
    ])
    expect(await salesByDay(db, w.owner, { from: new Date(0), to: new Date(1000) }, all)).toEqual([])
  })

  it('groups payments by method and reports money and credit owed', async () => {
    const w = await tillWorld()
    await sales(w)
    expect(await paymentsByMethod(db, w.owner, range(), all)).toEqual([
      { method: 'cash', kind: 'payment', count: 3, amountCents: 156000 + 900000 + 78000 },
    ])
    expect(await moneyOwed(db, w.owner, all)).toEqual({ openOrders: 2, owedCents: 900000 + 156000, creditCents: 156000 })
    expect(await salesSummary(db, w.owner, range(), all)).toMatchObject({ orders: 3, paidCents: 1134000 })
  })

  it('lists customers with what they owe and their credit', async () => {
    const w = await tillWorld()
    await sales(w)
    const [c] = await listCustomers(db, w.owner)
    expect(c).toMatchObject({ name: 'Peter Wafula', phone: '+254712345678', orders: 2, owedCents: 1056000, creditCents: 156000 })
    expect(await listCustomers(db, w.owner, { search: '0712 345' })).toHaveLength(1)
    expect(await listCustomers(db, w.owner, { search: 'nobody' })).toHaveLength(0)
    expect((await getCustomer(db, w.owner, c.id)).id).toBe(c.id)
  })

  it('keeps managers to their outlets and refuses cashiers', async () => {
    const w = await tillWorld()
    await sales(w)
    await expect(salesByDay(db, w.cashier.ctx, range(), all)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(salesByDay(db, w.manager.ctx, range(), { outletId: w.eld })).rejects.toMatchObject({ code: 'forbidden' })
    const { updateStaff } = await import('@/server/services/staff')
    await updateStaff(db, w.owner, w.manager.membershipId, { outletIds: [w.eld] })
    const ctx = (await getTenantCtx(db, w.manager.userId))!
    expect(await salesByDay(db, ctx, range(), all)).toEqual([])
    expect(await listCustomers(db, ctx)).toEqual([])
  })

  it('counts negative stock in scope', async () => {
    const w = await tillWorld()
    await applyOp(db, w.device, adjustOp(w, -150000))
    expect(await attentionCounts(db, w.owner, all)).toEqual({ unmatched: 0, negative: 1 })
  })
})
