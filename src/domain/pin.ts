/*
 * PIN verifier the till can check offline with WebCrypto (argon2 is not in the browser).
 * PBKDF2-SHA256 over the PIN with a random per-membership salt. The server keeps an argon2 hash
 * of the same PIN for its own checks. Works in Node 20+ and every target browser.
 */

export const PIN_RE = /^\d{4,6}$/
export const PIN_KDF_ITERATIONS = 100_000

export type PinVerifier = { salt: string; verifier: string }

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_RE.test(pin)
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PIN_KDF_ITERATIONS },
    key,
    256,
  )
  return toBase64(new Uint8Array(bits))
}

/** A fresh verifier for `pin` with a new random salt. */
export async function createPinVerifier(pin: string): Promise<PinVerifier> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { salt: toBase64(salt), verifier: await derive(pin, salt) }
}

/** True when `pin` matches. Never throws: a malformed verifier is simply no match. */
export async function checkPin(pin: string, v: PinVerifier): Promise<boolean> {
  if (!isValidPin(pin)) return false
  try {
    const got = await derive(pin, fromBase64(v.salt))
    // Constant-time over the (fixed-length) encodings.
    if (got.length !== v.verifier.length) return false
    let diff = 0
    for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ v.verifier.charCodeAt(i)
    return diff === 0
  } catch {
    return false
  }
}

/** Device-local lockout after wrong PINs: 5 free tries, then 1 minute, doubling, capped at 1 hour. */
export function pinLockoutMs(consecutiveFailures: number): number {
  if (consecutiveFailures < 5) return 0
  return Math.min(60_000 * 2 ** (consecutiveFailures - 5), 3_600_000)
}
