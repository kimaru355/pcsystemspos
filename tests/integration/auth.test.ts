import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { loginAttempts, sessions, users } from '@/db/schema'
import { changePassword, login } from '@/server/auth/login'
import {
  createSession,
  invalidateSession,
  invalidateUserSessions,
  validateSession,
} from '@/server/auth/session'
import { hashSecret, verifySecret } from '@/server/auth/secret'
import { DomainError } from '@/server/errors'
import { SEED_PASSWORD, resetDb, seedBusiness } from '../helpers/db'

const DAY_MS = 24 * 60 * 60 * 1000

function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

async function ownerEmail(userId: string): Promise<string> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId))
  return row.email as string
}

describe('secret hashing', () => {
  it('verifies the right secret and rejects a wrong one', async () => {
    const hash = await hashSecret('s3cret-value')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifySecret(hash, 's3cret-value')).toBe(true)
    expect(await verifySecret(hash, 'other')).toBe(false)
  })

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await verifySecret('not-a-hash', 'x')).toBe(false)
  })
})

describe('sessions', () => {
  beforeEach(resetDb)

  it('stores only the sha256 of a 32-char base32 token', async () => {
    const { owner } = await seedBusiness()
    const { token, expiresAt } = await createSession(db, owner.userId)
    expect(token).toMatch(/^[A-Z2-7]{32}$/)
    const rows = await db.select().from(sessions)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(tokenId(token))
    expect(rows[0].id).not.toBe(token)
    const days = (expiresAt.getTime() - Date.now()) / DAY_MS
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('validates a live token and rejects an unknown one', async () => {
    const { owner } = await seedBusiness()
    const { token } = await createSession(db, owner.userId)
    expect((await validateSession(db, token))?.userId).toBe(owner.userId)
    expect(await validateSession(db, 'A'.repeat(32))).toBeNull()
  })

  it('returns null for an expired session and deletes it', async () => {
    const { owner } = await seedBusiness()
    const { token } = await createSession(db, owner.userId)
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, tokenId(token)))
    expect(await validateSession(db, token)).toBeNull()
    expect(await db.select().from(sessions)).toHaveLength(0)
  })

  it('extends a session with 10 days left to about 30 days', async () => {
    const { owner } = await seedBusiness()
    const { token } = await createSession(db, owner.userId)
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 10 * DAY_MS) })
      .where(eq(sessions.id, tokenId(token)))
    const session = await validateSession(db, token)
    const days = (session!.expiresAt.getTime() - Date.now()) / DAY_MS
    expect(days).toBeGreaterThan(29.9)
    const [row] = await db.select().from(sessions)
    expect((row.expiresAt.getTime() - Date.now()) / DAY_MS).toBeGreaterThan(29.9)
  })

  it('does not touch a session with more than 15 days left', async () => {
    const { owner } = await seedBusiness()
    const { token } = await createSession(db, owner.userId)
    const target = new Date(Date.now() + 20 * DAY_MS)
    await db.update(sessions).set({ expiresAt: target }).where(eq(sessions.id, tokenId(token)))
    const session = await validateSession(db, token)
    expect(session!.expiresAt.getTime()).toBe(target.getTime())
  })

  it('invalidateSession removes just that session', async () => {
    const { owner } = await seedBusiness()
    const a = await createSession(db, owner.userId)
    const b = await createSession(db, owner.userId)
    await invalidateSession(db, a.token)
    expect(await validateSession(db, a.token)).toBeNull()
    expect((await validateSession(db, b.token))?.userId).toBe(owner.userId)
  })

  it('invalidateUserSessions removes every session of the user only', async () => {
    const one = await seedBusiness()
    const two = await seedBusiness()
    const a = await createSession(db, one.owner.userId)
    const b = await createSession(db, one.owner.userId)
    const other = await createSession(db, two.owner.userId)
    await invalidateUserSessions(db, one.owner.userId)
    expect(await validateSession(db, a.token)).toBeNull()
    expect(await validateSession(db, b.token)).toBeNull()
    expect((await validateSession(db, other.token))?.userId).toBe(two.owner.userId)
  })
})

describe('login', () => {
  beforeEach(resetDb)

  it('logs in with email and password and issues a valid session', async () => {
    const { owner } = await seedBusiness()
    const email = await ownerEmail(owner.userId)
    const result = await login(db, { identifier: email, password: SEED_PASSWORD })
    if (!result.ok) throw new Error('expected ok')
    expect(result.mustChangePassword).toBe(false)
    expect((await validateSession(db, result.token))?.userId).toBe(owner.userId)
  })

  it('treats the email case-insensitively and trims it', async () => {
    const { owner } = await seedBusiness()
    const email = (await ownerEmail(owner.userId)).toUpperCase()
    const result = await login(db, { identifier: `  ${email} `, password: SEED_PASSWORD })
    expect(result.ok).toBe(true)
  })

  it('logs in by a local-format phone when the stored phone is E.164', async () => {
    const { owner } = await seedBusiness({ ownerPhone: '+254712345678' })
    const result = await login(db, { identifier: '0712345678', password: SEED_PASSWORD })
    if (!result.ok) throw new Error('expected ok')
    expect((await validateSession(db, result.token))?.userId).toBe(owner.userId)
  })

  it('reports mustChangePassword', async () => {
    const { owner } = await seedBusiness()
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, owner.userId))
    const email = await ownerEmail(owner.userId)
    const result = await login(db, { identifier: email, password: SEED_PASSWORD })
    expect(result).toMatchObject({ ok: true, mustChangePassword: true })
  })

  it('gives the same response for a wrong password, unknown email and bad phone', async () => {
    const { owner } = await seedBusiness()
    const email = await ownerEmail(owner.userId)
    const expected = { ok: false, reason: 'invalid' }
    expect(await login(db, { identifier: email, password: 'wrong-password' })).toEqual(expected)
    expect(await login(db, { identifier: 'nobody@nowhere.test', password: 'x' })).toEqual(expected)
    expect(await login(db, { identifier: '0799999999', password: 'x' })).toEqual(expected)
    expect(await login(db, { identifier: 'not a phone', password: 'x' })).toEqual(expected)
  })

  it('records an attempt per login keyed by the normalized identifier', async () => {
    const { owner } = await seedBusiness({ ownerPhone: '+254712345678' })
    const email = await ownerEmail(owner.userId)
    await login(db, { identifier: '0712345678', password: 'wrong-password' })
    await login(db, { identifier: ` ${email.toUpperCase()}`, password: SEED_PASSWORD })
    const rows = await db.select().from(loginAttempts)
    expect(rows.map((r) => [r.identifier, r.success]).sort()).toEqual(
      [
        ['+254712345678', false],
        [email, true],
      ].sort(),
    )
  })

  it('locks after 5 failures even for the correct password, until the window passes', async () => {
    const { owner } = await seedBusiness()
    const email = await ownerEmail(owner.userId)
    for (let i = 0; i < 5; i++) {
      expect(await login(db, { identifier: email, password: 'wrong-password' })).toEqual({
        ok: false,
        reason: 'invalid',
      })
    }
    expect(await login(db, { identifier: email, password: SEED_PASSWORD })).toEqual({
      ok: false,
      reason: 'locked',
    })

    const rows = await db.select().from(loginAttempts)
    for (const row of rows) {
      await db
        .update(loginAttempts)
        .set({ attemptedAt: new Date(row.attemptedAt.getTime() - 16 * 60 * 1000) })
        .where(eq(loginAttempts.id, row.id))
    }
    const result = await login(db, { identifier: email, password: SEED_PASSWORD })
    expect(result.ok).toBe(true)
  })

  it('locks an unknown identifier the same way as a known one', async () => {
    for (let i = 0; i < 5; i++) {
      await login(db, { identifier: 'ghost@nowhere.test', password: 'x' })
    }
    expect(await login(db, { identifier: 'ghost@nowhere.test', password: 'x' })).toEqual({
      ok: false,
      reason: 'locked',
    })
  })

  it('does not lock other identifiers', async () => {
    const { owner } = await seedBusiness()
    const email = await ownerEmail(owner.userId)
    for (let i = 0; i < 5; i++) {
      await login(db, { identifier: 'ghost@nowhere.test', password: 'x' })
    }
    const result = await login(db, { identifier: email, password: SEED_PASSWORD })
    expect(result.ok).toBe(true)
  })
})

describe('changePassword', () => {
  beforeEach(resetDb)

  it('rejects a 7-character new password', async () => {
    const { owner } = await seedBusiness()
    const err = await changePassword(db, owner.userId, SEED_PASSWORD, '1234567').catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('invalid_input')
  })

  it('rejects a wrong current password and leaves the password unchanged', async () => {
    const { owner } = await seedBusiness()
    const err = await changePassword(db, owner.userId, 'not-the-password', 'new-password-1').catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('forbidden')
    const email = await ownerEmail(owner.userId)
    expect((await login(db, { identifier: email, password: SEED_PASSWORD })).ok).toBe(true)
  })

  it('changes the password and clears must_change_password', async () => {
    const { owner } = await seedBusiness()
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, owner.userId))
    await changePassword(db, owner.userId, SEED_PASSWORD, 'new-password-1')
    const email = await ownerEmail(owner.userId)
    expect(await login(db, { identifier: email, password: SEED_PASSWORD })).toMatchObject({
      ok: false,
    })
    // fresh identifier state: the failed attempt above counts once, well under the limit
    const result = await login(db, { identifier: email, password: 'new-password-1' })
    expect(result).toMatchObject({ ok: true, mustChangePassword: false })
  })
})
