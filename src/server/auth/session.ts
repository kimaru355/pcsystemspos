import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { sessions } from '@/db/schema'

export const SESSION_COOKIE = 'pos_session'
export const SESSION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000
const EXTEND_BELOW_DAYS = 15
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding. 20 bytes encode to exactly 32 characters. */
function base32(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function expiryFromNow(): Date {
  return new Date(Date.now() + SESSION_DAYS * DAY_MS)
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = base32(randomBytes(20))
  const expiresAt = expiryFromNow()
  await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt })
  return { token, expiresAt }
}

/**
 * Looks the token up by its hash (the DB never holds the raw token). Expired
 * sessions are deleted; sessions with under 15 days left are pushed to 30 days.
 */
export async function validateSession(
  db: Db,
  token: string,
): Promise<{ userId: string; expiresAt: Date } | null> {
  const id = hashToken(token)
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id))
  if (!row) return null

  const now = Date.now()
  if (row.expiresAt.getTime() <= now) {
    await db.delete(sessions).where(eq(sessions.id, id))
    return null
  }

  if (row.expiresAt.getTime() - now < EXTEND_BELOW_DAYS * DAY_MS) {
    const expiresAt = expiryFromNow()
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id))
    return { userId: row.userId, expiresAt }
  }
  return { userId: row.userId, expiresAt: row.expiresAt }
}

export async function invalidateSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)))
}

export async function invalidateUserSessions(db: Db, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}
