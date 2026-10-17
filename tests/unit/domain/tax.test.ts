import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAX_CATEGORY,
  isTaxCategory,
  TAX_CATEGORIES,
  TAX_LABELS,
  vatRateBp,
} from '@/domain/tax'

describe('tax categories', () => {
  it('lists categories in A-E order', () => {
    expect(TAX_CATEGORIES).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('defaults to B', () => {
    expect(DEFAULT_TAX_CATEGORY).toBe('B')
  })

  it('derives VAT rates in basis points', () => {
    expect(vatRateBp('B')).toBe(1600)
    expect(vatRateBp('E')).toBe(800)
    expect(vatRateBp('A')).toBe(0)
    expect(vatRateBp('C')).toBe(0)
    expect(vatRateBp('D')).toBe(0)
  })

  it('labels every category', () => {
    expect(TAX_LABELS).toEqual({
      A: 'A — Exempt',
      B: 'B — 16% VAT',
      C: 'C — Zero-rated',
      D: 'D — Non-VAT',
      E: 'E — 8% VAT',
    })
  })

  it('guards category values', () => {
    expect(isTaxCategory('F')).toBe(false)
    expect(isTaxCategory('b')).toBe(false)
    expect(isTaxCategory(undefined)).toBe(false)
    expect(isTaxCategory(null)).toBe(false)
    expect(isTaxCategory(1)).toBe(false)
    for (const c of TAX_CATEGORIES) expect(isTaxCategory(c)).toBe(true)
  })
})
