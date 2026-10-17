import type { TillItem, TillOrder } from './types'

/*
 * SAMPLE DATA, development preview only (`/till?preview=1` with `next dev`).
 * Items, prices and the order below are illustrative, not a real shop's.
 * Replace with the outlet's catalogue once items and orders exist.
 */
const VAT = 1600

export const SAMPLE_ITEMS: TillItem[] = [
  { id: 's-cem', code: 'CEM50', name: 'Cement 50 kg', unit: 'bag', priceCents: 78000, vatRateBp: VAT, availableMilli: 142000, lowStockMilli: 40000 },
  { id: 's-is30', code: 'IS30', name: 'Iron sheet 30 gauge 3 m', unit: 'sheet', priceCents: 115000, vatRateBp: VAT, availableMilli: 18000, lowStockMilli: 25000 },
  { id: 's-y12', code: 'Y12', name: 'Steel bar Y12 12 m', unit: 'length', priceCents: 105000, vatRateBp: VAT, availableMilli: 64000, lowStockMilli: 20000 },
  { id: 's-nl', code: 'NL3', name: 'Wire nails 3 inch', unit: 'kg', priceCents: 26000, vatRateBp: VAT, availableMilli: 87500, lowStockMilli: 15000 },
  { id: 's-rn', code: 'RN', name: 'Roofing nails', unit: 'kg', priceCents: 32000, vatRateBp: VAT, availableMilli: 41000, lowStockMilli: 10000 },
  { id: 's-bw', code: 'BW', name: 'Binding wire', unit: 'kg', priceCents: 28000, vatRateBp: VAT, availableMilli: 33000, lowStockMilli: 10000 },
  { id: 's-pvc', code: 'PVC12', name: 'PVC pipe ½ inch 6 m', unit: 'length', priceCents: 45000, vatRateBp: VAT, availableMilli: 120000, lowStockMilli: 30000 },
  { id: 's-ppr', code: 'PPR20', name: 'PPR pipe 20 mm 4 m', unit: 'length', priceCents: 52000, vatRateBp: VAT, availableMilli: 0, lowStockMilli: 20000 },
  { id: 's-pw4', code: 'PW4', name: 'Gloss paint white 4 L', unit: 'tin', priceCents: 240000, vatRateBp: VAT, availableMilli: 22000, lowStockMilli: 6000 },
  { id: 's-pr1', code: 'PR1', name: 'Red oxide primer 1 L', unit: 'tin', priceCents: 65000, vatRateBp: VAT, availableMilli: 15000, lowStockMilli: 5000 },
  { id: 's-tb', code: 'TB22', name: 'Timber 2×2 cypress', unit: 'ft', priceCents: 3500, vatRateBp: VAT, availableMilli: 960000, lowStockMilli: 200000 },
  { id: 's-mesh', code: 'MESH', name: 'Chain link mesh 1.2 m', unit: 'metre', priceCents: 21000, vatRateBp: VAT, availableMilli: 75500, lowStockMilli: 20000 },
  { id: 's-pl', code: 'PL50', name: 'Padlock 50 mm', unit: 'piece', priceCents: 65000, vatRateBp: VAT, availableMilli: 9000, lowStockMilli: 5000 },
  { id: 's-tk', code: 'TK1K', name: 'Water tank 1,000 L', unit: 'piece', priceCents: 980000, vatRateBp: VAT, availableMilli: 4000, lowStockMilli: 2000 },
  { id: 's-gl', code: 'GLV', name: 'Work gloves', unit: 'pair', priceCents: 15000, vatRateBp: VAT, availableMilli: 60000, lowStockMilli: 12000 },
  { id: 's-sd', code: 'SAND', name: 'River sand', unit: 'tonne', priceCents: 250000, vatRateBp: VAT, availableMilli: 12500, lowStockMilli: 5000 },
]

export const SAMPLE_ORDER: TillOrder = {
  number: 'KTL-03-000124',
  customer: { name: 'Peter Wafula', phone: '0712 345 678' },
  lines: [
    { lineId: 'l1', itemId: 's-cem', qtyMilli: 10000, unitPriceCents: 78000, vatRateBp: VAT, collectedMilli: 10000 },
    { lineId: 'l2', itemId: 's-is30', qtyMilli: 12000, unitPriceCents: 115000, vatRateBp: VAT, collectedMilli: 4000 },
    { lineId: 'l3', itemId: 's-nl', qtyMilli: 2000, unitPriceCents: 26000, vatRateBp: VAT, collectedMilli: 2000 },
  ],
  paidCents: 1500000,
  events: [
    { status: 'Collected', tone: 'neutral', detail: '10 bags cement, 4 of 12 iron sheets, 2 kg nails.', by: 'Jane', at: '10:47', balance: '8 sheets still to collect.' },
    { status: 'Paid', tone: 'paid', detail: 'KES 10,000.00 by M-Pesa.', by: 'Jane', at: '10:44', balance: 'Balance KES 7,120.00.' },
    { status: 'Paid', tone: 'paid', detail: 'KES 5,000.00 cash.', by: 'Jane', at: '10:41', balance: 'Balance KES 17,120.00.' },
  ],
}
