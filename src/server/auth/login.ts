import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { loginAttempts, users } from '@/db/schema'
import { normalizeKePhone } from '@/domain/phone'
import { DomainError } from '../errors'
import { hashSecret, verifySecret } from './secret'
import { createSession } from './session'

export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000
export const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 200

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; mustChangePassword: boolean }
  | { ok: false; reason: 'invalid' | 'locked' }

// Verified against when the identifier matches no user, so an unknown account
// costs the same argon2 work as a wrong password.
let dummyHash: Promise<string> | undefined

/** Email (contains "@") is trimmed and lowercased; anything else must be a Kenyan phone. */
function normalizeIdentifier(raw: string): { kind: 'email' | 'phone'; value: string } | null {
  const trimmed = raw.trim()
  if (trimmed.includes('@')) return { kind: 'email', value: trimmed.toLowerCase() }
  const phone = normalizeKePhone(trimmed)
  return phone ? { kind: 'phone', value: phone } : null
}

export async function login(
  db: Db,
  input: { identifier: string; password: string },
): Promise<LoginResult> {
  const identity = normalizeIdentifier(input.identifier)
  // Unparseable identifiers are keyed by their trimmed text so they lock like any other.
  const key = identity?.value ?? input.identifier.trim().toLowerCase().slice(0, 200)

  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS)
  const [{ failures }] = await db
    .select({ failures: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, key),
        eq(loginAttempts.success, false),
        gte(loginAttempts.attemptedAt, since),
      ),
    )
  if (failures >= MAX_FAILED_ATTEMPTS) {
    await db.insert(loginAttempts).values({ identifier: key, success: false })
    return { ok: false, reason: 'locked' }
  }

  let user: { id: string; passwordHash: string; mustChangePassword: boolean } | undefined
  if (identity) {
    const where =
      identity.kind === 'email'
        ? sql`lower(${users.email}) = ${identity.value}`
        : eq(users.phone, identity.value)
    ;[user] = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(where)
  }

  let passwordOk: boolean
  if (user) {
    passwordOk = await verifySecret(user.passwordHash, input.password)
  } else {
    dummyHash ??= hashSecret('dummy-password-for-timing')
    await verifySecret(await dummyHash, input.password)
    passwordOk = false
  }

  await db.insert(loginAttempts).values({ identifier: key, success: passwordOk })
  if (!passwordOk || !user) return { ok: false, reason: 'invalid' }

  const { token, expiresAt } = await createSession(db, user.id)
  return { ok: true, token, expiresAt, mustChangePassword: user.mustChangePassword }
}

export async function changePassword(
  db: Db,
  userId: string,
  current: string,
  next: string,
): Promise<void> {
  if (next.length < MIN_PASSWORD_LENGTH) {
    throw new DomainError(
      'invalid_input',
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
  }
  if (next.length > MAX_PASSWORD_LENGTH) {
    throw new DomainError('invalid_input', 'Password is too long.')
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
  if (!user) throw new DomainError('not_found', 'User not found.')
  if (!(await verifySecret(user.passwordHash, current))) {
    throw new DomainError('forbidden', 'Current password is incorrect.')
  }

  await db
    .update(users)
    .set({ passwordHash: await hashSecret(next), mustChangePassword: false })
    .where(eq(users.id, userId))
}
