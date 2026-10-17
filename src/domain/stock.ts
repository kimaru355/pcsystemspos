import type { Milli } from './money'

export type MovementKind = 'receive' | 'adjust' | 'collect'

export type AdjustReason = 'damaged' | 'count_correction' | 'lost_stolen' | 'other'

export const ADJUST_REASONS: readonly AdjustReason[] = [
  'damaged',
  'count_correction',
  'lost_stolen',
  'other',
]

export const ADJUST_REASON_LABELS: Record<AdjustReason, string> = {
  damaged: 'Damaged',
  count_correction: 'Count correction',
  lost_stolen: 'Lost or stolen',
  other: 'Other',
}

/** True when a quantity is a whole number of base units (a multiple of 1000 milli). */
export function isWholeUnits(qtyMilli: Milli): boolean {
  return qtyMilli % 1000 === 0
}

/** Movement needed to take on-hand to a counted quantity (counted - on-hand). */
export function countToDelta(onHandMilli: Milli, countedMilli: Milli): Milli {
  return countedMilli - onHandMilli
}

/** Stock free to sell: on-hand less what is owed to customers (collect-later). */
export function availableMilli(onHandMilli: Milli, owedMilli: Milli): Milli {
  return onHandMilli - owedMilli
}

/** Low when available is at or below the item's level; never low when no level is set. */
export function isLowStock(available: Milli, lowStockMilli: Milli | null): boolean {
  return lowStockMilli !== null && available <= lowStockMilli
}
