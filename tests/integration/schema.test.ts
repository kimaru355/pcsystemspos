import { verify } from '@node-rs/argon2'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { memberships, outlets, users } from '@/db/schema'
import { SEED_PASSWORD, resetDb, seedBusiness } from '../helpers/db'

/** Drizzle wraps driver errors; the Postgres error is on `cause`. */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } }
    return err.cause?.code ?? err.code
  }
  return undefined
}

describe('schema constraints', () => {
  beforeEach(resetDb)

  it('seeds a business with one outlet per code', async () => {
    const seeded = await seedBusiness({ outletCodes: ['KTL', 'THK'] })
    expect(seeded.outletIds).toHaveLength(2)
  })

  it('rejects a duplicate outlet code within one business', async () => {
    const { businessId } = await seedBusiness({ outletCodes: ['KTL'] })
    const code = await pgCode(db.insert(outlets).values({ businessId, name: 'Dup', code: 'KTL' }))
    expect(code).toBe('23505')
  })

  it('allows the same outlet code in another business', async () => {
    await seedBusiness({ outletCodes: ['KTL'] })
    const other = await seedBusiness({ outletCodes: ['KTL'] })
    expect(other.outletIds).toHaveLength(1)
  })

  it('rejects a user with neither email nor phone', async () => {
    const code = await pgCode(db.insert(users).values({ name: 'Ghost', passwordHash: 'x' }))
    expect(code).toBe('23514')
  })

  it('rejects a second membership for the same user', async () => {
    const { businessId, owner } = await seedBusiness()
    const code = await pgCode(
      db.insert(memberships).values({ businessId, userId: owner.userId, role: 'cashier' }),
    )
    expect(code).toBe('23505')
  })

  it('stores a normalized owner phone and a verifiable argon2 password hash', async () => {
    const { owner } = await seedBusiness({ ownerPhone: '0712 345 678' })
    const [row] = await db.select().from(users).where(eq(users.id, owner.userId))
    expect(row.phone).toBe('+254712345678')
    expect(await verify(row.passwordHash, SEED_PASSWORD)).toBe(true)
  })

  it('seeds two businesses without colliding on owner email', async () => {
    await seedBusiness()
    await expect(seedBusiness()).resolves.toBeDefined()
  })
})
