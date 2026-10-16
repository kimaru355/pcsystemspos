import { and, eq, gte, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { loginAttempts } from '@/db/schema'

export const MAX_FAILED_ATTEMPTS = 5
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000

export type Reservation = { locked: true } | { locked: false; attemptId: string }

/**
 * Atomically checks the lockout and reserves an attempt. Under a per-key advisory lock
 * it counts failures in the window; at the limit it returns `locked` without inserting
 * (so hammering a locked key does not extend the window). Otherwise it inserts a
 * failed attempt row up front, so concurrent requests cannot all read a stale count.
 * The caller verifies the secret afterwards and calls `completeAttempt` on success.
 */
export async function reserveAttempt(db: Db, key: string): Promise<Reservation> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`)
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MS)
    const [{ failures }] = await tx
      .select({ failures: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.identifier, key),
          eq(loginAttempts.success, false),
          gte(loginAttempts.attemptedAt, since),
        ),
      )
    if (failures >= MAX_FAILED_ATTEMPTS) return { locked: true } as const
    const [row] = await tx
      .insert(loginAttempts)
      .values({ identifier: key, success: false })
      .returning({ id: loginAttempts.id })
    return { locked: false, attemptId: row.id } as const
  })
}

/** Marks a reserved attempt as successful. */
export async function completeAttempt(db: Db, attemptId: string): Promise<void> {
  await db.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, attemptId))
}
