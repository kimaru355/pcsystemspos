import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { items, loginAttempts, messageOutbox, sessions } from '@/db/schema'
import { purgeAuthData, queueLowStockDigests, runJobs } from '@/server/jobs'
import { adjustStock } from '@/server/services/stock'
import { resetDb } from '../helpers/db'
import { tillWorld } from './till-helpers'

describe('jobs', () => {
  beforeEach(resetDb)

  it('emails owners and managers the low stock of their outlets, once a day', async () => {
    const w = await tillWorld()
    // Cement is low at 5 bags: take it down to 3 at KTL.
    await adjustStock(db, w.owner, { outletId: w.ktl, itemId: w.cement.id, deltaMilli: -97000, reason: 'count_correction' })
    const day = new Date('2026-10-20T05:00:00Z') // 08:00 Nairobi
    // The owner (KTL and ELD, where cement is empty) and the KTL manager.
    expect(await queueLowStockDigests(db, day)).toBe(2)
    expect(await queueLowStockDigests(db, day)).toBe(0)
    const rows = await db.select().from(messageOutbox)
    expect(rows.map((r) => r.channel)).toEqual(['email', 'email'])
    expect(rows[0].body).toContain('Cement 50kg: 3 bags free (low at 5)')
    expect(rows[0].subject).toBe(`Low stock today · Test Hardware ${rows[0].subject!.split('Hardware ')[1]}`)
    expect(await queueLowStockDigests(db, new Date('2026-10-21T05:00:00Z'))).toBe(2)
  })

  it('skips people with nothing low', async () => {
    await tillWorld()
    // Cement (empty at ELD) is the only item with a low-stock level; remove the level.
    await db.update(items).set({ lowStockMilli: null })
    expect(await queueLowStockDigests(db, new Date())).toBe(0)
  })

  it('purges old login attempts and expired sessions', async () => {
    const w = await tillWorld()
    const now = new Date()
    await db.insert(loginAttempts).values([
      { identifier: 'x', success: false, attemptedAt: new Date(now.getTime() - 40 * 86400_000) },
      { identifier: 'y', success: false, attemptedAt: now },
    ])
    await db.insert(sessions).values([
      { id: 'old', userId: w.owner.userId, expiresAt: new Date(now.getTime() - 1000) },
      { id: 'new', userId: w.owner.userId, expiresAt: new Date(now.getTime() + 86400_000) },
    ])
    expect(await purgeAuthData(db, now)).toEqual({ attempts: 1, sessions: 1 })
    expect(await db.select().from(sessions).where(eq(sessions.id, 'new'))).toHaveLength(1)
  })

  it('runs everything in one call', async () => {
    await tillWorld()
    const r = await runJobs(db, new Date('2026-10-20T03:00:00Z'), { sms: null, email: null })
    expect(r).toMatchObject({ stkTimedOut: 0, digests: 0, messages: { sent: 0 } })
  })
})
