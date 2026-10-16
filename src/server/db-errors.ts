/** True for a Postgres unique violation, whether or not the driver error is wrapped. */
export function isUniqueViolation(e: unknown): boolean {
  for (let err = e as { code?: unknown; cause?: unknown } | undefined, i = 0; err && i < 3; i++) {
    if (err.code === '23505') return true
    err = err.cause as typeof err
  }
  return false
}
