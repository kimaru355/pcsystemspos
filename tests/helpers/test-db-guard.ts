/** Throws unless the database named in `url` ends with `_test` (destructive helpers must never touch real data). */
export function assertTestDatabase(url: string | undefined): void {
  let name = ''
  try {
    name = decodeURIComponent(new URL(url ?? '').pathname.replace(/^\//, ''))
  } catch {
    // fall through: an unparseable or missing URL is refused below
  }
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to reset database "${name || url || '(unset)'}": its name must end with "_test".`,
    )
  }
}
