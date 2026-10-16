const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a canonical 8-4-4-4-12 hex uuid. Guards raw form strings before they reach a uuid column. */
export function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s)
}
