/** True for a Postgres unique violation, whether or not the driver error is wrapped. */
export function isUniqueViolation(e: unknown): boolean {
  for (let err = e as { code?: unknown; cause?: unknown } | undefined, i = 0; err && i < 3; i++) {
    if (err.code === '23505') return true
    err = err.cause as typeof err
  }
  return false
}

/** Name of the violated unique constraint/index, when the driver reports it (walks wrapped errors). */
export function uniqueViolationConstraint(e: unknown): string | undefined {
  for (
    let err = e as { code?: unknown; constraint?: unknown; cause?: unknown } | undefined, i = 0;
    err && i < 3;
    i++
  ) {
    if (err.code === '23505' && typeof err.constraint === 'string') return err.constraint
    err = err.cause as typeof err
  }
  return undefined
}
