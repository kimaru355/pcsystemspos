import { describe, expect, it } from 'vitest'
import {
  balanceCents,
  checkCollection,
  collectedValueCents,
  defaultCollectionRequest,
  orderTotals,
  outstandingMilli,
  requiresNamedCustomer,
  type OrderLine,
} from '@/domain/orders'

const cement: OrderLine = {
  lineId: 'L1',
  itemId: 'cement',
  qtyMilli: 5000,
  unitPriceCents: 75000,
  vatRateBp: 1600,
  collectedMilli: 0,
}
const onHand = { cement: 10000 }

const check = (
  over: Partial<Parameters<typeof checkCollection>[0]> & { request: { lineId: string; qtyMilli: number }[] },
) => checkCollection({ lines: [cement], paidCents: 375000, creditCents: 0, onHandMilli: onHand, ...over })

describe('order math', () => {
  it('computes gross and VAT totals', () => {
    expect(orderTotals([cement])).toEqual({ grossCents: 375000, vatCents: 51724 })
  })

  it('sums several lines', () => {
    const nails: OrderLine = { ...cement, lineId: 'L2', itemId: 'nails', qtyMilli: 2500, unitPriceCents: 12000, vatRateBp: 0 }
    expect(orderTotals([cement, nails])).toEqual({ grossCents: 405000, vatCents: 51724 })
  })

  it('computes outstanding quantity', () => {
    expect(outstandingMilli(cement)).toBe(5000)
    expect(outstandingMilli({ ...cement, collectedMilli: 2000 })).toBe(3000)
  })

  it('values what has already been collected', () => {
    expect(collectedValueCents([{ ...cement, collectedMilli: 2000 }])).toBe(150000)
  })

  it('reports balance, negative when overpaid', () => {
    expect(balanceCents([cement], 150000)).toBe(225000)
    expect(balanceCents([cement], 400000)).toBe(-25000)
  })

  it('defaults to collecting everything outstanding', () => {
    expect(defaultCollectionRequest([cement])).toEqual([{ lineId: 'L1', qtyMilli: 5000 }])
    expect(defaultCollectionRequest([{ ...cement, collectedMilli: 5000 }])).toEqual([])
    expect(defaultCollectionRequest([{ ...cement, collectedMilli: 2000 }])).toEqual([
      { lineId: 'L1', qtyMilli: 3000 },
    ])
  })
})

describe('checkCollection', () => {
  it('allows collecting everything when fully paid', () => {
    expect(check({ request: [{ lineId: 'L1', qtyMilli: 5000 }] })).toEqual({ ok: true, valueCents: 375000 })
  })

  it('allows partial collection up to the paid amount', () => {
    expect(check({ paidCents: 150000, request: [{ lineId: 'L1', qtyMilli: 2000 }] })).toEqual({
      ok: true,
      valueCents: 150000,
    })
  })

  it('rejects collection beyond the paid amount with the shortfall', () => {
    expect(check({ paidCents: 150000, request: [{ lineId: 'L1', qtyMilli: 3000 }] })).toEqual({
      ok: false,
      reason: 'exceeds_paid',
      shortfallCents: 75000,
    })
  })

  it('counts approved credit towards what may be collected', () => {
    const r = check({ paidCents: 150000, creditCents: 75000, request: [{ lineId: 'L1', qtyMilli: 3000 }] })
    expect(r.ok).toBe(true)
  })

  it('handles a second visit against outstanding quantity', () => {
    const lines = [{ ...cement, collectedMilli: 2000 }]
    expect(check({ lines, request: [{ lineId: 'L1', qtyMilli: 3000 }] })).toEqual({ ok: true, valueCents: 225000 })
    expect(check({ lines, request: [{ lineId: 'L1', qtyMilli: 3001 }] })).toEqual({
      ok: false,
      reason: 'exceeds_outstanding',
      lineId: 'L1',
    })
  })

  it('counts earlier collections against the paid amount', () => {
    const lines = [{ ...cement, collectedMilli: 2000 }]
    expect(check({ lines, paidCents: 150000, request: [{ lineId: 'L1', qtyMilli: 1000 }] })).toEqual({
      ok: false,
      reason: 'exceeds_paid',
      shortfallCents: 75000,
    })
  })

  it('does not let per-piece rounding block a fully paid split collection', () => {
    const line: OrderLine = { ...cement, qtyMilli: 1000, unitPriceCents: 1001, vatRateBp: 0, collectedMilli: 500 }
    expect(check({ lines: [line], paidCents: 1001, request: [{ lineId: 'L1', qtyMilli: 500 }] })).toEqual({
      ok: true,
      valueCents: 500,
    })
  })

  it('rejects collecting more than is on hand', () => {
    expect(check({ onHandMilli: { cement: 1000 }, request: [{ lineId: 'L1', qtyMilli: 2000 }] })).toEqual({
      ok: false,
      reason: 'exceeds_stock',
      lineId: 'L1',
    })
  })

  it('treats an item missing from on-hand as zero stock', () => {
    expect(check({ onHandMilli: {}, request: [{ lineId: 'L1', qtyMilli: 1000 }] })).toEqual({
      ok: false,
      reason: 'exceeds_stock',
      lineId: 'L1',
    })
  })

  it('aggregates stock per item across lines', () => {
    const a: OrderLine = { ...cement, lineId: 'A', qtyMilli: 3000 }
    const b: OrderLine = { ...cement, lineId: 'B', qtyMilli: 3000 }
    const r = check({
      lines: [a, b],
      paidCents: 450000,
      onHandMilli: { cement: 5000 },
      request: [
        { lineId: 'A', qtyMilli: 3000 },
        { lineId: 'B', qtyMilli: 3000 },
      ],
    })
    expect(r).toEqual({ ok: false, reason: 'exceeds_stock', lineId: 'B' })
  })

  it.each([
    ['duplicate line', [{ lineId: 'L1', qtyMilli: 1000 }, { lineId: 'L1', qtyMilli: 1000 }], 'L1'],
    ['zero quantity', [{ lineId: 'L1', qtyMilli: 0 }], 'L1'],
    ['negative quantity', [{ lineId: 'L1', qtyMilli: -1000 }], 'L1'],
    ['fractional milli', [{ lineId: 'L1', qtyMilli: 1.5 }], 'L1'],
    ['unknown line', [{ lineId: 'X', qtyMilli: 1000 }], 'X'],
  ])('rejects an invalid request (%s) even when nothing is paid', (_name, request, lineId) => {
    expect(check({ paidCents: 0, request })).toEqual({ ok: false, reason: 'invalid_request', lineId })
  })
})

describe('requiresNamedCustomer', () => {
  const collected = { ...cement, collectedMilli: 5000 }

  it('is false when fully paid and fully collected', () => {
    expect(requiresNamedCustomer({ lines: [collected], paidCents: 375000, creditCents: 0 })).toBe(false)
  })

  it('is true when not fully paid', () => {
    expect(requiresNamedCustomer({ lines: [collected], paidCents: 300000, creditCents: 0 })).toBe(true)
  })

  it('is true when quantity is still outstanding', () => {
    expect(requiresNamedCustomer({ lines: [cement], paidCents: 375000, creditCents: 0 })).toBe(true)
  })

  it('is true when credit is used', () => {
    expect(requiresNamedCustomer({ lines: [collected], paidCents: 375000, creditCents: 100 })).toBe(true)
  })
})
