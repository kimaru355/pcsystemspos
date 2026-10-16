import { eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { memberships, users } from '@/db/schema'
import { normalizeKePhone } from '@/domain/phone'
import { DomainError } from '../errors'
import { completeAttempt, reserveAttempt } from './lockout'
import { hashSecret, verifySecret } from './secret'
import { createSession, invalidateUserSessions } from './session'

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

  const reservation = await reserveAttempt(db, key)
  if (reservation.locked) return { ok: false, reason: 'locked' }

  let user:
    | { id: string; passwordHash: string; mustChangePassword: boolean; allowed: boolean }
    | undefined
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
        // Platform admins have no membership; everyone else needs an active one.
        allowed: sql<boolean>`(${users.isPlatformAdmin} or ${memberships.active} is true)`,
      })
      .from(users)
      .leftJoin(memberships, eq(memberships.userId, users.id))
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

  // A deactivated user is indistinguishable from a wrong password (same path and timing).
  if (!passwordOk || !user || !user.allowed) return { ok: false, reason: 'invalid' }

  await completeAttempt(db, reservation.attemptId)
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

  const reservation = await reserveAttempt(db, `pwchange:${userId}`)
  if (reservation.locked) {
    throw new DomainError('forbidden', 'Too many attempts. Try again in 15 minutes.')
  }

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
  if (!user) throw new DomainError('not_found', 'User not found.')
  if (!(await verifySecret(user.passwordHash, current))) {
    throw new DomainError('forbidden', 'Current password is incorrect.')
  }
  await completeAttempt(db, reservation.attemptId)

  await db
    .update(users)
    .set({ passwordHash: await hashSecret(next), mustChangePassword: false })
    .where(eq(users.id, userId))
  // Revoke every session (including any a thief holds); the caller issues a fresh one.
  await invalidateUserSessions(db, userId)
}
