import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatKes,
  formatQty,
  lineGross,
  parseMoney,
  parseQty,
  vatPortion,
} from '@/domain/money'

describe('parseQty', () => {
  it('parses decimals into thousandths', () => {
    expect(parseQty('2.5')).toBe(2500)
    expect(parseQty('0.1')).toBe(100)
    expect(parseQty('1.005')).toBe(1005)
    expect(parseQty('0')).toBe(0)
    expect(parseQty(' 3 ')).toBe(3000)
  })

  it.each(['1.2345', '-1', '1e3', '', 'abc', '1.2.3'])('throws RangeError for %j', (input) => {
    expect(() => parseQty(input)).toThrow(RangeError)
  })
})

describe('formatQty', () => {
  it('trims trailing zeros', () => {
    expect(formatQty(2500)).toBe('2.5')
    expect(formatQty(5000)).toBe('5')
    expect(formatQty(1005)).toBe('1.005')
    expect(formatQty(100)).toBe('0.1')
    expect(formatQty(0)).toBe('0')
  })
})

describe('parseMoney', () => {
  it('parses into cents', () => {
    expect(parseMoney('1,250.50')).toBe(125050)
    expect(parseMoney('750')).toBe(75000)
    expect(parseMoney('0.5')).toBe(50)
    expect(parseMoney(' 12.05 ')).toBe(1205)
  })

  it.each(['1.234', '-5', '', 'abc', '1,25.00', '1.2.3'])('throws RangeError for %j', (input) => {
    expect(() => parseMoney(input)).toThrow(RangeError)
  })
})

describe('formatKes', () => {
  it('formats with thousands separator and two decimals', () => {
    expect(formatKes(125000)).toBe('KES 1,250.00')
    expect(formatKes(-5000)).toBe('-KES 50.00')
    expect(formatKes(0)).toBe('KES 0.00')
    expect(formatKes(5)).toBe('KES 0.05')
    expect(formatKes(123456789)).toBe('KES 1,234,567.89')
  })
})

describe('lineGross', () => {
  it('multiplies milli-quantity by unit price in cents', () => {
    expect(lineGross(2500, 12000)).toBe(30000)
    expect(lineGross(5000, 75000)).toBe(375000)
  })
})

describe('vatPortion', () => {
  it('extracts the VAT portion from a VAT-inclusive gross', () => {
    expect(vatPortion(116000, 1600)).toBe(16000)
    expect(vatPortion(75000, 1600)).toBe(10345)
    expect(vatPortion(75000, 0)).toBe(0)
  })
})

describe('safe-integer guards', () => {
  it('parseQty throws RangeError past the safe integer range', () => {
    expect(() => parseQty('9007199254740.993')).toThrow(RangeError)
  })

  it('parseMoney throws RangeError past the safe integer range', () => {
    expect(() => parseMoney('90071992547409.93')).toThrow(RangeError)
  })

  it('lineGross throws RangeError when the product is unsafe', () => {
    expect(() => lineGross(Number.MAX_SAFE_INTEGER, 2)).toThrow(RangeError)
  })

  it('still accepts values at the edge of safety', () => {
    expect(parseQty('9007199254740.991')).toBe(Number.MAX_SAFE_INTEGER)
    expect(lineGross(1000, 100)).toBe(100)
  })
})

describe('formatAmount', () => {
  it('formats cents for a field and round-trips through parseMoney', () => {
    expect(formatAmount(95000)).toBe('950')
    expect(formatAmount(125050)).toBe('1,250.50')
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(5)).toBe('0.05')
    for (const c of [0, 5, 95000, 125050, 99999999]) expect(parseMoney(formatAmount(c))).toBe(c)
  })
})
