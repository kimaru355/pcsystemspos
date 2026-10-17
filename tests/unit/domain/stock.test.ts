import { describe, expect, it } from 'vitest'
import {
  ADJUST_REASON_LABELS,
  ADJUST_REASONS,
  availableMilli,
  countToDelta,
  isLowStock,
  isWholeUnits,
} from '@/domain/stock'

describe('isWholeUnits', () => {
  it('accepts multiples of 1000 milli', () => {
    expect(isWholeUnits(3000)).toBe(true)
    expect(isWholeUnits(0)).toBe(true)
    expect(isWholeUnits(2500)).toBe(false)
    expect(isWholeUnits(1)).toBe(false)
  })
})

describe('countToDelta', () => {
  it('is counted minus on-hand', () => {
    expect(countToDelta(50000, 47000)).toBe(-3000)
    expect(countToDelta(0, 5000)).toBe(5000)
    expect(countToDelta(5000, 5000)).toBe(0)
  })
})

describe('availableMilli', () => {
  it('is on-hand minus owed', () => {
    expect(availableMilli(10000, 4000)).toBe(6000)
  })
})

describe('isLowStock', () => {
  it('is true at or below the low-stock level', () => {
    expect(isLowStock(8000, 10000)).toBe(true)
    expect(isLowStock(10000, 10000)).toBe(true)
    expect(isLowStock(10001, 10000)).toBe(false)
  })

  it('is false when no level is set', () => {
    expect(isLowStock(0, null)).toBe(false)
  })
})

describe('adjust reasons', () => {
  it('lists and labels every reason', () => {
    expect(ADJUST_REASONS).toEqual(['damaged', 'count_correction', 'lost_stolen', 'other'])
    expect(ADJUST_REASON_LABELS).toEqual({
      damaged: 'Damaged',
      count_correction: 'Count correction',
      lost_stolen: 'Lost or stolen',
      other: 'Other',
    })
  })
})
