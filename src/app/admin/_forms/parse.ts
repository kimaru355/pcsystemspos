import { parseMoney, parseQty, type Cents, type Milli } from '@/domain/money'
import { FieldError } from './form-state'

export const MONEY_MESSAGE = 'Enter an amount like 950 or 1,250.50'
export const QTY_MESSAGE = 'Enter a quantity like 2 or 2.5'

export function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '')
}

/** '' -> null, otherwise the id. */
export function optionalId(formData: FormData, key: string): string | null {
  const v = text(formData, key)
  return v === '' ? null : v
}

export function money(formData: FormData, key: string): Cents {
  try {
    return parseMoney(text(formData, key))
  } catch (e) {
    if (e instanceof RangeError) throw new FieldError(key, MONEY_MESSAGE)
    throw e
  }
}

export function qty(formData: FormData, key: string): Milli {
  try {
    return parseQty(text(formData, key))
  } catch (e) {
    if (e instanceof RangeError) throw new FieldError(key, QTY_MESSAGE)
    throw e
  }
}

/** Blank -> null. */
export function optionalQty(formData: FormData, key: string): Milli | null {
  return text(formData, key).trim() === '' ? null : qty(formData, key)
}

/** Blank -> null. */
export function optionalMoney(formData: FormData, key: string): Cents | null {
  return text(formData, key).trim() === '' ? null : money(formData, key)
}

/** A quantity with an optional leading + or - ("-2.5"), for stock changes. */
export function signedQty(formData: FormData, key: string): Milli {
  const raw = text(formData, key).trim()
  const negative = raw.startsWith('-')
  const body = raw.startsWith('-') || raw.startsWith('+') ? raw.slice(1).trim() : raw
  let value: Milli
  try {
    value = parseQty(body)
  } catch (e) {
    if (e instanceof RangeError) throw new FieldError(key, 'Enter a change like 5 or -2.5')
    throw e
  }
  return negative ? -value : value
}
