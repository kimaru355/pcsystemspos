/** KRA-style tax categories. VAT rates are derived only through `vatRateBp`. */
export type TaxCategory = 'A' | 'B' | 'C' | 'D' | 'E'

export const TAX_CATEGORIES: readonly TaxCategory[] = ['A', 'B', 'C', 'D', 'E']

export const DEFAULT_TAX_CATEGORY: TaxCategory = 'B'

export const TAX_LABELS: Record<TaxCategory, string> = {
  A: 'A — Exempt',
  B: 'B — 16% VAT',
  C: 'C — Zero-rated',
  D: 'D — Non-VAT',
  E: 'E — 8% VAT',
}

const VAT_RATE_BP: Record<TaxCategory, number> = { A: 0, B: 1600, C: 0, D: 0, E: 800 }

/** VAT rate in basis points for a tax category. */
export function vatRateBp(cat: TaxCategory): number {
  return VAT_RATE_BP[cat]
}

export function isTaxCategory(v: unknown): v is TaxCategory {
  return typeof v === 'string' && (TAX_CATEGORIES as readonly string[]).includes(v)
}
