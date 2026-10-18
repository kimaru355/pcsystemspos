import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, customers, devices, orderLines, orders, outletStock, payments, stockMovements } from '@/db/schema'
import { authenticateDevice, registerDevice } from '@/server/services/devices'
import { cancelRemainder, getOrder, listOrders, recordRefund } from '@/server/services/orders'
import { listStock, owedMilliFor } from '@/server/services/stock'
import { applyOp, sync } from '@/server/services/sync'
import { resetDb } from '../helpers/db'
import { checkoutOp, CLOCK, collectionOp, paymentOp, tillWorld, uuid, type TillWorld } from './till-helpers'

const customer = { name: 'Peter Wafula', phone: '0712 345 678' }

async function onHand(w: TillWorld, itemId: string) {
  const [r] = await db
    .select()
    .from(outletStock)
    .where(and(eq(outletStock.outletId, w.ktl), eq(outletStock.itemId, itemId)))
  return r
}

async function applied(w: TillWorld, op: Parameters<typeof applyOp>[2]) {
  const r = await applyOp(db, w.device, op)
  expect(r).toMatchObject({ status: 'applied' })
}

describe('sale.checkout', () => {
  beforeEach(resetDb)

  it('records a walk-in sale paid and collected in full, and closes it', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { cashCents: 156000 })
    await applied(w, op)
    const d = await getOrder(db, w.owner, op.payload.order.id)
    expect(d.state).toMatchObject({ status: 'closed', paidCents: 156000, customer: null })
    expect(d.figures).toMatchObject({ totalCents: 156000, balanceCents: 0 })
    expect((await onHand(w, w.cement.id)).onHandMilli).toBe(98000)
    const [m] = await db.select().from(stockMovements).where(eq(stockMovements.kind, 'collect'))
    expect(m).toMatchObject({ qtyMilli: -2000, orderLineId: op.payload.order.lines[0].id, deviceId: w.device.deviceId })
    const [dev] = await db.select().from(devices).where(eq(devices.id, w.device.deviceId))
    expect(dev.lastOrderSeq).toBe(op.payload.order.seq)
  })

  it('sells packs and moves base units', async () => {
    const w = await tillWorld()
    const line = {
      id: uuid(),
      itemId: w.sheet.id,
      packId: w.bundle.id,
      qtyMilli: 2000,
      unitPriceCents: 1800000,
      listPriceCents: 1800000,
      floorCents: 1750000,
      priceApproverId: null,
    }
    await applied(w, checkoutOp(w, { lines: [line], cashCents: 3600000 }))
    expect((await onHand(w, w.sheet.id)).onHandMilli).toBe(60000)
    const [l] = await db.select().from(orderLines).where(eq(orderLines.id, line.id))
    expect(l).toMatchObject({ unitLabel: 'bundle', baseQtyPerUnitMilli: 20000, collectedMilli: 2000, vatRateBp: 1600 })
  })

  it('a part payment keeps the order open, owes the goods and links the customer', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { cashCents: 50000, collect: 'none', customer })
    await applied(w, op)
    const d = await getOrder(db, w.owner, op.payload.order.id)
    expect(d.state.customer).toEqual({ name: 'Peter Wafula', phone: '+254712345678' })
    expect(d.state.status).toBe('open')
    expect((await owedMilliFor(db, w.ktl, [w.cement.id])).get(w.cement.id)).toBe(2000)
    const [row] = await listStock(db, w.owner, w.ktl, { search: 'Cement' })
    expect(row).toMatchObject({ onHandMilli: 100000, owedMilli: 2000, availableMilli: 98000 })
    expect(await db.select().from(customers)).toHaveLength(1)
  })

  it('rejects a sale that leaves something owed without a customer', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { cashCents: 50000, collect: 'none' })
    expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'rejected', code: 'invalid_input' })
    expect(await db.select().from(orders)).toHaveLength(0)
  })

  it('needs a manager for a price below the floor, and audits it', async () => {
    const w = await tillWorld()
    const low = {
      id: uuid(),
      itemId: w.cement.id,
      packId: null,
      qtyMilli: 1000,
      unitPriceCents: 70000,
      listPriceCents: 78000,
      floorCents: 75000,
      priceApproverId: w.cashier.membershipId,
    }
    expect(await applyOp(db, w.device, checkoutOp(w, { lines: [low], cashCents: 70000 }))).toMatchObject({
      status: 'rejected',
      code: 'forbidden',
    })
    await applied(w, checkoutOp(w, { lines: [{ ...low, id: uuid(), priceApproverId: w.manager.membershipId }], cashCents: 70000 }))
    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, 'order.price_override'))
    expect(a.data).toMatchObject({ unitPriceCents: 70000, approvedBy: w.manager.userId })
  })

  it('turns an approved shortfall into credit', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { cashCents: 78000, customer, creditApproverId: w.manager.membershipId })
    await applied(w, op)
    const d = await getOrder(db, w.owner, op.payload.order.id)
    expect(d.state.creditCents).toBe(78000)
    expect(d.figures.creditInUseCents).toBe(78000)
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'order.credit')))).toHaveLength(1)
  })

  it('refuses an order number that does not belong to this till', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { cashCents: 156000 })
    op.payload.order.number = op.payload.order.number.replace('KTL', 'ELD')
    expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'rejected', code: 'invalid_input' })
  })

  it('a reused order id is rejected without touching the first order', async () => {
    const w = await tillWorld()
    const first = checkoutOp(w, { cashCents: 156000 })
    await applied(w, first)
    const second = checkoutOp(w, { cashCents: 156000, orderId: first.payload.order.id })
    expect(await applyOp(db, w.device, second)).toMatchObject({ status: 'rejected', code: 'conflict' })
    expect((await onHand(w, w.cement.id)).onHandMilli).toBe(98000)
  })
})

describe('later payments and collections', () => {
  beforeEach(resetDb)

  async function openOrder(w: TillWorld) {
    const op = checkoutOp(w, { cashCents: 50000, collect: 'none', customer })
    await applied(w, op)
    return { orderId: op.payload.order.id, lineId: op.payload.order.lines[0].id }
  }

  it('pays the balance, then collects in two visits, then closes', async () => {
    const w = await tillWorld()
    const { orderId, lineId } = await openOrder(w)
    await applied(w, paymentOp(w, orderId, 106000))
    await applied(w, collectionOp(w, orderId, [{ lineId, qtyMilli: 1000 }]))
    expect((await getOrder(db, w.owner, orderId)).state.status).toBe('open')
    await applied(w, collectionOp(w, orderId, [{ lineId, qtyMilli: 1000 }]))
    const d = await getOrder(db, w.owner, orderId)
    expect(d.state.status).toBe('closed')
    expect(d.state.events.map((e) => e.kind)).toEqual(['collection', 'collection', 'payment', 'payment', 'created'])
    expect((await owedMilliFor(db, w.ktl, [w.cement.id])).get(w.cement.id)).toBe(0)
  })

  it('two tills offline collecting against one payment: both recorded, order flagged', async () => {
    const w = await tillWorld()
    const { orderId, lineId } = await openOrder(w) // paid 500 of 1,560; nothing collected
    // Each till saw "paid 500" and took one bag (780) with a manager's credit for 280...
    // ...but the second till's credit approval only covered its own view.
    await applied(w, collectionOp(w, orderId, [{ lineId, qtyMilli: 1000 }], w.manager.membershipId))
    const second = collectionOp(w, orderId, [{ lineId, qtyMilli: 1000 }])
    await applied(w, second)
    const d = await getOrder(db, w.owner, orderId)
    expect(d.state.flagged).toBe(true)
    expect(d.state.lines[0].collectedMilli).toBe(2000)
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'order.over_collected')))).toHaveLength(1)
  })

  it('collections may take stock negative on sync, flagging the item', async () => {
    const w = await tillWorld()
    const line = {
      id: uuid(),
      itemId: w.cement.id,
      packId: null,
      qtyMilli: 150000,
      unitPriceCents: 78000,
      listPriceCents: 78000,
      floorCents: 75000,
      priceApproverId: null,
    }
    await applied(w, checkoutOp(w, { lines: [line], cashCents: 117000000 }))
    const r = await onHand(w, w.cement.id)
    expect(r.onHandMilli).toBe(-50000)
    expect(r.flaggedNegativeAt).toBeInstanceOf(Date)
  })

  it('mark-paid needs an approver and a reason, and is audited with both', async () => {
    const w = await tillWorld()
    const { orderId } = await openOrder(w)
    const op = paymentOp(w, orderId, 106000)
    const p = op.payload as { payment: { method: string; reason: string | null; approverId: string | null } }
    p.payment.method = 'mark_paid'
    expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'rejected', code: 'forbidden' })
    const ok = paymentOp(w, orderId, 106000)
    Object.assign((ok.payload as typeof p).payment, { method: 'mark_paid', reason: 'Bank transfer seen', approverId: w.manager.membershipId })
    await applied(w, ok)
    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, 'order.mark_paid'))
    expect(a).toMatchObject({ reason: 'Bank transfer seen', deviceId: w.device.deviceId })
    expect(a.data).toMatchObject({ approvedBy: w.manager.userId })
  })

  it('an order of another outlet cannot be paid from this till', async () => {
    const w = await tillWorld()
    const { orderId } = await openOrder(w)
    const reg = await registerDevice(db, w.owner, { outletId: w.eld, name: 'ELD' })
    const auth = await authenticateDevice(db, reg.token)
    if (!auth.ok) throw new Error()
    expect(await applyOp(db, auth.device, paymentOp(w, orderId, 1000, w.manager.membershipId))).toMatchObject({
      status: 'rejected',
      code: 'conflict',
    })
  })

  it('the orders section carries open orders with their events', async () => {
    const w = await tillWorld()
    const { orderId } = await openOrder(w)
    const r = await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })
    const o = r.sections.orders!.data.orders.find((x) => x.id === orderId)!
    expect(o).toMatchObject({ status: 'open', paidCents: 50000 })
    expect(o.events[0]).toMatchObject({ kind: 'payment', amountCents: 50000 })
  })
})

describe('admin: cancel remainder and refund', () => {
  beforeEach(resetDb)

  it('cancels what is left, then refunds what was paid beyond the new total', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, {
      cashCents: 156000,
      customer,
      collect: [{ lineId: '', qtyMilli: 1000 }],
    })
    op.payload.collection!.lines[0].lineId = op.payload.order.lines[0].id
    await applied(w, op)
    const orderId = op.payload.order.id
    await expect(cancelRemainder(db, w.cashier.ctx, orderId, { reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
    await cancelRemainder(db, w.manager.ctx, orderId, { reason: 'Out of stock for weeks' })
    let d = await getOrder(db, w.owner, orderId)
    expect(d.figures.totalCents).toBe(78000)
    expect(d.refundableCents).toBe(78000)
    expect(d.state.status).toBe('closed')
    expect((await owedMilliFor(db, w.ktl, [w.cement.id])).get(w.cement.id)).toBe(0)
    await expect(
      recordRefund(db, w.owner, orderId, { amountCents: 78001, method: 'cash', reason: 'Refund' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await recordRefund(db, w.owner, orderId, { amountCents: 78000, method: 'mpesa', reason: 'Sent back by M-Pesa' })
    d = await getOrder(db, w.owner, orderId)
    expect(d.state.paidCents).toBe(78000)
    expect(d.refundableCents).toBe(0)
    expect(d.state.events[0]).toMatchObject({ kind: 'refund', amountCents: 78000 })
    const refunds = await db.select().from(payments).where(eq(payments.kind, 'refund'))
    expect(refunds).toHaveLength(1)
    await expect(cancelRemainder(db, w.owner, orderId, { reason: 'again' })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('lists orders in scope with search and filters', async () => {
    const w = await tillWorld()
    const a = checkoutOp(w, { cashCents: 156000 })
    const b = checkoutOp(w, { cashCents: 50000, collect: 'none', customer })
    await applied(w, a)
    await applied(w, b)
    expect((await listOrders(db, w.owner)).map((o) => o.number)).toEqual([b.payload.order.number, a.payload.order.number])
    expect((await listOrders(db, w.owner, { status: 'open' })).map((o) => o.id)).toEqual([b.payload.order.id])
    expect((await listOrders(db, w.owner, { search: 'wafula' })).map((o) => o.id)).toEqual([b.payload.order.id])
    expect((await listOrders(db, w.owner, { search: '0712345' })).map((o) => o.id)).toEqual([b.payload.order.id])
    await expect(listOrders(db, w.cashier.ctx)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await listOrders(db, w.manager.ctx, { outletId: w.eld })).toEqual([])
  })
})
