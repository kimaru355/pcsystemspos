import { describe, expect, it } from 'vitest'
import {
  applyCollection,
  applyCustomer,
  applyPayment,
  buildLines,
  checkNamedCustomer,
  formatOrderNumber,
  orderFigures,
  parseCustomer,
  planCancelRemainder,
  planCheckout,
  refundableCents,
  type LineInput,
  type OrderState,
  type SellableUnit,
} from '@/domain/order-state'
import { isValidSoldQty, toBaseMilli } from '@/domain/orders'

const ITEM = '11111111-1111-4111-8111-111111111111'
const PACK = '22222222-2222-4222-8222-222222222222'
const MANAGER = '33333333-3333-4333-8333-333333333333'
const CASHIER = '44444444-4444-4444-8444-444444444444'
const L1 = '55555555-5555-4555-8555-555555555551'
const L2 = '55555555-5555-4555-8555-555555555552'

const sheet: SellableUnit = {
  itemId: ITEM,
  packId: null,
  name: 'Iron sheet',
  unitLabel: 'sheet',
  baseQtyPerUnitMilli: 1000,
  fractional: false,
  taxCategory: 'B',
}
const bundle: SellableUnit = { ...sheet, packId: PACK, unitLabel: 'bundle', baseQtyPerUnitMilli: 20000 }
const unitOf = (_itemId: string, packId: string | null) => (packId === PACK ? bundle : packId === null ? sheet : null)
const isApprover = (id: string) => id === MANAGER

const line = (over: Partial<LineInput> = {}): LineInput => ({
  id: L1,
  itemId: ITEM,
  packId: null,
  qtyMilli: 3000,
  unitPriceCents: 100000,
  listPriceCents: 100000,
  floorCents: 90000,
  priceApproverId: null,
  ...over,
})

function lines(...inputs: LineInput[]) {
  const r = buildLines(inputs, unitOf, isApprover)
  if (!r.ok) throw new Error(r.error.message)
  return r.lines
}

function checkout(over: Partial<Parameters<typeof planCheckout>[0]> = {}, mode: 'till' | 'server' = 'till') {
  return planCheckout(
    {
      id: 'o1',
      number: 'KTL-01-000001',
      outletId: 'out',
      occurredAt: '2026-10-18T10:00:00.000Z',
      by: 'Jane',
      customer: null,
      lines: lines(line()),
      payments: [],
      collection: null,
      ...over,
    },
    { mode, onHand: mode === 'server' ? null : new Map([[ITEM, 100000]]), isApprover },
  )
}

const cash = (amountCents: number, id = 'p1') => ({ id, method: 'cash' as const, amountCents, reason: null, approverId: null })
const takeAll = (qtyMilli = 3000, creditApproverId: string | null = null) => ({
  id: 'c1',
  lines: [{ lineId: L1, qtyMilli }],
  creditApproverId,
})

function order(r: ReturnType<typeof checkout>): OrderState {
  if (!r.ok) throw new Error(r.error.message)
  return r.order
}

describe('sold quantities', () => {
  it('converts packs to base units exactly', () => {
    expect(toBaseMilli(2000, 20000)).toBe(40000)
    expect(toBaseMilli(2500)).toBe(2500)
    expect(() => toBaseMilli(1, 1500)).toThrow(RangeError)
  })

  it('sells packs and whole-unit items in whole numbers only', () => {
    expect(isValidSoldQty(2000, true, true)).toBe(true)
    expect(isValidSoldQty(1500, true, true)).toBe(false)
    expect(isValidSoldQty(1500, false, false)).toBe(false)
    expect(isValidSoldQty(1500, false, true)).toBe(true)
    expect(isValidSoldQty(0, false, true)).toBe(false)
  })
})

describe('buildLines', () => {
  it('snapshots the catalog unit and VAT rate', () => {
    const [l] = lines(line({ packId: PACK, qtyMilli: 2000, unitPriceCents: 1800000, listPriceCents: 1800000, floorCents: 0 }))
    expect(l).toMatchObject({ unitLabel: 'bundle', baseQtyPerUnitMilli: 20000, vatRateBp: 1600, collectedMilli: 0 })
  })

  it('refuses half a bundle and half a sheet', () => {
    expect(buildLines([line({ packId: PACK, qtyMilli: 500 })], unitOf, isApprover).ok).toBe(false)
    expect(buildLines([line({ qtyMilli: 2500 })], unitOf, isApprover).ok).toBe(false)
  })

  it('needs an approver below the floor', () => {
    const low = line({ unitPriceCents: 80000 })
    const r = buildLines([low], unitOf, isApprover)
    expect(r.ok === false && r.error.code).toBe('forbidden')
    expect(buildLines([{ ...low, priceApproverId: CASHIER }], unitOf, isApprover).ok).toBe(false)
    expect(buildLines([{ ...low, priceApproverId: MANAGER }], unitOf, isApprover).ok).toBe(true)
  })

  it('refuses an unknown item, an empty order and duplicate line ids', () => {
    expect(buildLines([line({ packId: 'nope' })], unitOf, isApprover).ok).toBe(false)
    expect(buildLines([], unitOf, isApprover).ok).toBe(false)
    expect(buildLines([line(), line()], unitOf, isApprover).ok).toBe(false)
  })
})

describe('planCheckout', () => {
  it('a walk-in sale paid and collected in full closes the order', () => {
    const o = order(checkout({ payments: [cash(300000)], collection: takeAll() }))
    expect(o.status).toBe('closed')
    expect(orderFigures(o)).toMatchObject({ totalCents: 300000, paidCents: 300000, balanceCents: 0, creditInUseCents: 0 })
  })

  it('anything left owed needs a named customer', () => {
    const r = checkout({ payments: [cash(100000)], collection: null })
    expect(r.ok).toBe(false)
    const o = order(
      checkout({ payments: [cash(100000)], customer: { name: 'Peter', phone: '+254712345678' } }),
    )
    expect(o.status).toBe('open')
  })

  it('the till refuses collecting beyond what is paid without an approver', () => {
    const r = checkout({ payments: [cash(100000)], collection: takeAll(2000), customer: { name: 'P', phone: '+254712345678' } })
    expect(r.ok === false && r.error.code).toBe('forbidden')
  })

  it('an approver turns the shortfall into credit', () => {
    const r = checkout({
      payments: [cash(100000)],
      collection: takeAll(2000, MANAGER),
      customer: { name: 'P', phone: '+254712345678' },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.order.creditCents).toBe(100000)
    expect(r.collection).toMatchObject({ valueCents: 200000, creditGrantedCents: 100000, overCollected: false })
    expect(orderFigures(r.order).creditInUseCents).toBe(100000)
  })

  it('the server accepts an over-collection and flags it', () => {
    const r = checkout(
      { payments: [cash(100000)], collection: takeAll(2000), customer: { name: 'P', phone: '+254712345678' } },
      'server',
    )
    expect(r.ok && r.order.flagged).toBe(true)
    expect(r.ok && r.collection?.overCollected).toBe(true)
  })

  it('the till refuses collecting more than is on hand; the server does not check stock', () => {
    const r = planCheckout(
      {
        id: 'o1',
        number: 'n',
        outletId: 'out',
        occurredAt: 't',
        by: 'J',
        customer: null,
        lines: lines(line()),
        payments: [cash(300000)],
        collection: takeAll(),
      },
      { mode: 'till', onHand: new Map([[ITEM, 2000]]), isApprover },
    )
    expect(r.ok === false && r.error.code).toBe('conflict')
  })

  it('mark-paid needs an approver and a reason', () => {
    const mp = { id: 'p1', method: 'mark_paid' as const, amountCents: 300000, reason: 'Bank transfer', approverId: CASHIER }
    expect(checkout({ payments: [mp], collection: takeAll() }).ok).toBe(false)
    expect(checkout({ payments: [{ ...mp, approverId: MANAGER, reason: ' ' }], collection: takeAll() }).ok).toBe(false)
    expect(checkout({ payments: [{ ...mp, approverId: MANAGER }], collection: takeAll() }).ok).toBe(true)
  })

  it('an overpaid walk-in sale keeps the balance on the order', () => {
    const o = order(checkout({ payments: [cash(350000)], collection: takeAll() }))
    expect(o.status).toBe('closed')
    expect(orderFigures(o).balanceCents).toBe(-50000)
    expect(refundableCents(o)).toBe(50000)
  })
})

describe('later visits', () => {
  const customer = { name: 'Peter', phone: '+254712345678' }
  const open = () => order(checkout({ payments: [cash(100000)], customer }))
  const ctx = { at: 't2', by: 'Jane', isApprover }

  it('a payment then a collection closes the order', () => {
    const p = applyPayment(open(), cash(200000, 'p2'), ctx)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    const c = applyCollection(p.order, takeAll(), { ...ctx, mode: 'till', onHand: { [ITEM]: 3000 } })
    expect(c.ok && c.order.status).toBe('closed')
    expect(c.ok && c.moves).toEqual([{ lineId: L1, itemId: ITEM, qtyMilli: 3000, baseQtyMilli: 3000 }])
  })

  it('collections of a pack line move base units', () => {
    const o = order(
      checkout({
        lines: lines(line({ id: L2, packId: PACK, qtyMilli: 2000, unitPriceCents: 1000, listPriceCents: 1000, floorCents: 0 })),
        payments: [cash(2000)],
        customer,
      }),
    )
    const c = applyCollection(o, { id: 'c', lines: [{ lineId: L2, qtyMilli: 1000 }], creditApproverId: null }, {
      ...ctx,
      mode: 'till',
      onHand: { [ITEM]: 20000 },
    })
    expect(c.ok && c.moves[0].baseQtyMilli).toBe(20000)
  })

  it('a customer is set once and never replaced', () => {
    const o = open()
    expect(applyCustomer(o, { name: 'Other', phone: '+254700000000' }).customer).toEqual(customer)
    const walkIn = { ...o, customer: null }
    expect(applyCustomer(walkIn, customer).customer).toEqual(customer)
    expect(checkNamedCustomer(walkIn).ok).toBe(false)
  })
})

describe('cancel remainder', () => {
  it('cancels what is left; the refund is what was paid beyond the new total', () => {
    const o = order(
      checkout({
        payments: [cash(300000)],
        collection: takeAll(1000),
        customer: { name: 'P', phone: '+254712345678' },
      }),
    )
    const r = planCancelRemainder(o)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cancelled).toEqual([{ lineId: L1, qtyMilli: 2000 }])
    expect(orderFigures(r.order).totalCents).toBe(100000)
    expect(refundableCents(r.order)).toBe(200000)
    expect(planCancelRemainder(r.order).ok).toBe(false)
  })
})

describe('helpers', () => {
  it('formats order numbers', () => {
    expect(formatOrderNumber('KTL', '03', 123)).toBe('KTL-03-000123')
  })

  it('parses customers', () => {
    expect(parseCustomer({ name: ' Peter ', phone: '0712 345 678' })).toEqual({
      ok: true,
      customer: { name: 'Peter', phone: '+254712345678' },
    })
    expect(parseCustomer({ name: '', phone: '' })).toEqual({ ok: true, customer: null })
    expect(parseCustomer({ name: 'Peter', phone: '123' }).ok).toBe(false)
    expect(parseCustomer({ name: '', phone: '0712345678' }).ok).toBe(false)
  })
})
