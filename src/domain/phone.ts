/**
 * Normalise a Kenyan mobile number to E.164 (`+2547XXXXXXXX` / `+2541XXXXXXXX`).
 * Accepts `07XXXXXXXX`, `7XXXXXXXX`, `2547XXXXXXXX`, `+254 7XX XXX XXX` and the `01` range.
 * Returns null when the input is not a valid Kenyan mobile number.
 */
export function normalizeKePhone(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '').replace(/^\+/, '')
  const m = /^(?:254|0)?([17]\d{8})$/.exec(digits)
  return m ? `+254${m[1]}` : null
}
