/** Money is integer cents (KES). Quantities are integer thousandths. No floats for money. */
export type Cents = number
export type Milli = number

const QTY_RE = /^\d+(\.\d{1,3})?$/
const MONEY_RE = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/

/** Scale a validated decimal string to an integer with `places` decimals, via string splitting (no parseFloat). */
function scaled(input: string, places: number): number {
  const [whole, frac = ''] = input.split('.')
  return Number(whole) * 10 ** places + Number(frac.padEnd(places, '0') || '0')
}

function assertSafe(n: number, what: string): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} is too large`)
  return n
}

/** Parse a quantity such as "2.5" into thousandths (2500). Max 3 decimals, non-negative. */
export function parseQty(input: string): Milli {
  const s = input.trim()
  if (!QTY_RE.test(s)) throw new RangeError(`Invalid quantity: ${JSON.stringify(input)}`)
  return assertSafe(scaled(s, 3), 'Quantity')
}

/** Format thousandths as a decimal string with trailing zeros trimmed (2500 -> "2.5"). */
export function formatQty(q: Milli): string {
  const sign = q < 0 ? '-' : ''
  const abs = Math.abs(q)
  const whole = Math.trunc(abs / 1000)
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${sign}${whole}${frac ? `.${frac}` : ''}`
}

/** Parse a money string such as "1,250.50" into cents. Max 2 decimals, non-negative. */
export function parseMoney(input: string): Cents {
  const s = input.trim()
  if (!MONEY_RE.test(s)) throw new RangeError(`Invalid amount: ${JSON.stringify(input)}`)
  return assertSafe(scaled(s.replace(/,/g, ''), 2), 'Amount')
}

/** Format cents as "KES 1,250.00" (negatives as "-KES 50.00"). Locale-independent. */
export function formatKes(c: Cents): string {
  const sign = c < 0 ? '-' : ''
  const abs = Math.abs(c)
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = String(abs % 100).padStart(2, '0')
  return `${sign}KES ${whole}.${frac}`
}

/** Cents as typed in a field, without the currency: 95000 -> "950", 125050 -> "1,250.50". */
export function formatAmount(c: Cents): string {
  return formatKes(c).replace(/^(-?)KES /, '$1').replace(/\.00$/, '')
}

/** Gross value of a line: quantity (thousandths) x unit price (cents), rounded to whole cents. */
export function lineGross(qtyMilli: Milli, unitPriceCents: Cents): Cents {
  return Math.round(assertSafe(qtyMilli * unitPriceCents, 'Line value') / 1000)
}

/** VAT contained in a VAT-inclusive gross amount, given the rate in basis points. */
export function vatPortion(grossCents: Cents, vatRateBp: number): Cents {
  return Math.round((grossCents * vatRateBp) / (10000 + vatRateBp))
}
