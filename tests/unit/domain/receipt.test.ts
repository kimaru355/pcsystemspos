import { describe, expect, it } from 'vitest'
import { buildReceipt, escposBytes, receiptSms, receiptText, smsSegments, taxBreakdown } from '@/domain/receipt'
import type { OrderState } from '@/domain/order-state'

const order: OrderState = {
  id: 'o1',
  number: 'KTL-03-000123',
  outletId: 'out',
  status: 'open',
  customer: { name: 'Peter Wafula', phone: '+254712345678' },
  lines: [
    {
      lineId: 'l1', itemId: 'i1', packId: null, name: 'Cement 50kg', unitLabel: 'bag', baseQtyPerUnitMilli: 1000,
      qtyMilli: 5000, collectedMilli: 2000, cancelledMilli: 0, unitPriceCents: 78000, listPriceCents: 78000,
      floorCents: 75000, taxCategory: 'B', vatRateBp: 1600, position: 0,
    },
    {
      lineId: 'l2', itemId: 'i2', packId: null, name: 'Maize flour', unitLabel: 'kg', baseQtyPerUnitMilli: 1000,
      qtyMilli: 2000, collectedMilli: 2000, cancelledMilli: 0, unitPriceCents: 10000, listPriceCents: 10000,
      floorCents: 10000, taxCategory: 'A', vatRateBp: 0, position: 1,
    },
  ],
  paidCents: 200000,
  creditCents: 0,
  flagged: false,
  occurredAt: '2026-10-20T07:00:00.000Z',
  events: [
    { kind: 'collection', at: '2026-10-20T07:10:00.000Z', by: 'Jane', amountCents: 176000, sourceId: 'c1', lines: [{ lineId: 'l1', qtyMilli: 2000 }, { lineId: 'l2', qtyMilli: 2000 }] },
    { kind: 'payment', at: '2026-10-20T07:05:00.000Z', by: 'Jane', amountCents: 200000, method: 'mpesa', sourceId: 'p1', reference: 'SJK1' },
    { kind: 'created', at: '2026-10-20T07:00:00.000Z', by: 'Jane' },
  ],
}
const place = { business: 'Acme Hardware', outlet: { code: 'KTL', name: 'Kitale' } }

describe('receipts', () => {
  it('breaks VAT down by tax category', () => {
    expect(taxBreakdown(order)).toEqual([
      { category: 'A', rateBp: 0, grossCents: 20000, vatCents: 0 },
      { category: 'B', rateBp: 1600, grossCents: 390000, vatCents: 53793 },
    ])
  })

  it('builds an order receipt for a payment and a collection note with what was taken', () => {
    const r = buildReceipt(order, place, order.events[1])
    expect(r).toMatchObject({ kind: 'order', title: 'Receipt', payment: { method: 'mpesa', amountCents: 200000, reference: 'SJK1' }, kraInvoiceNumber: null })
    expect(r.totals).toMatchObject({ totalCents: 410000, paidCents: 200000, balanceCents: 210000 })
    const n = buildReceipt(order, place, order.events[0])
    expect(n.kind).toBe('collection')
    expect(n.takenNow).toEqual([
      { name: 'Cement 50kg', qtyMilli: 2000, unit: 'bag' },
      { name: 'Maize flour', qtyMilli: 2000, unit: 'kg' },
    ])
    expect(n.goodsOwed).toBe(true)
  })

  it('renders 48 columns with totals, VAT and what is owed', () => {
    const text = receiptText(buildReceipt(order, place, order.events[1]))
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48)
    expect(text).toContain('KTL-03-000123')
    expect(text).toContain('M-Pesa SJK1')
    expect(text).toMatch(/Balance owed\s+2,100\.00/)
    expect(text).toContain('2 collected, 3 still to collect')
    expect(text).toContain('KRA invoice no: -')
  })

  it('keeps the SMS to one part', () => {
    const sms = receiptSms(buildReceipt(order, place, order.events[0]))
    expect(sms).toContain('Collected 2 bags Cement 50kg, 2 kg Maize flour.')
    expect(smsSegments(sms)).toBe(1)
    expect(smsSegments('x'.repeat(161))).toBe(2)
    expect(smsSegments('✓'.repeat(71))).toBe(2)
  })

  it('makes ESC/POS bytes: init, ASCII text, cut', () => {
    const b = escposBytes('Café ✓')
    expect([...b.slice(0, 2)]).toEqual([0x1b, 0x40])
    expect(String.fromCharCode(...b.slice(2, 8))).toBe('Cafe ?')
    expect([...b.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x00])
  })
})
