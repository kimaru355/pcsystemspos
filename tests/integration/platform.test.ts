import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { businesses, memberships, users } from '@/db/schema'
import { login } from '@/server/auth/login'
import { DomainError } from '@/server/errors'
import { createBusinessWithOwner, createPlatformAdmin } from '@/server/services/platform'
import { resetDb } from '../helpers/db'

describe('createBusinessWithOwner', () => {
  beforeEach(resetDb)

  it('creates an active business, an owner membership and a user who must change password', async () => {
    const { businessId, ownerUserId } = await createBusinessWithOwner(db, {
      name: 'Kimaru Hardware',
      ownerName: 'Wanjiku',
      ownerEmail: '  Owner@Kimaru.TEST ',
      ownerPassword: 'temp-pass-1',
    })

    const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId))
    expect(business).toMatchObject({ name: 'Kimaru Hardware', status: 'active', defaultConnectionMode: 'default' })

    const [user] = await db.select().from(users).where(eq(users.id, ownerUserId))
    expect(user).toMatchObject({
      name: 'Wanjiku',
      email: 'owner@kimaru.test',
      phone: null,
      mustChangePassword: true,
      isPlatformAdmin: false,
    })
    expect(user.passwordHash).not.toBe('temp-pass-1')

    const rows = await db.select().from(memberships).where(eq(memberships.userId, ownerUserId))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ businessId, role: 'owner', active: true })
  })

  it('lets the owner log in with the temporary password (case-insensitive email)', async () => {
    await createBusinessWithOwner(db, {
      name: 'B',
      ownerName: 'O',
      ownerEmail: 'Owner@B.test',
      ownerPassword: 'temp-pass-1',
    })
    const result = await login(db, { identifier: 'owner@b.test', password: 'temp-pass-1' })
    expect(result).toMatchObject({ ok: true, mustChangePassword: true })
  })

  it('accepts a phone and stores it in E.164 form', async () => {
    const { ownerUserId } = await createBusinessWithOwner(db, {
      name: 'B',
      ownerName: 'O',
      ownerPhone: '0712 345 678',
      ownerPassword: 'temp-pass-1',
    })
    const [user] = await db.select().from(users).where(eq(users.id, ownerUserId))
    expect(user).toMatchObject({ phone: '+254712345678', email: null })
  })

  it('rejects an owner with neither email nor phone', async () => {
    await expect(
      createBusinessWithOwner(db, { name: 'B', ownerName: 'O', ownerPassword: 'temp-pass-1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await db.select().from(businesses)).toHaveLength(0)
  })

  it('rejects an invalid phone', async () => {
    await expect(
      createBusinessWithOwner(db, {
        name: 'B',
        ownerName: 'O',
        ownerPhone: '12345',
        ownerPassword: 'temp-pass-1',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await db.select().from(businesses)).toHaveLength(0)
  })

  it('rejects a short password and a blank name', async () => {
    await expect(
      createBusinessWithOwner(db, { name: 'B', ownerName: 'O', ownerEmail: 'a@b.test', ownerPassword: 'short' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      createBusinessWithOwner(db, { name: ' ', ownerName: 'O', ownerEmail: 'a@b.test', ownerPassword: 'temp-pass-1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('reports an existing email as a conflict and creates nothing', async () => {
    const input = { name: 'B', ownerName: 'O', ownerEmail: 'dup@b.test', ownerPassword: 'temp-pass-1' }
    await createBusinessWithOwner(db, input)
    const err = await createBusinessWithOwner(db, { ...input, name: 'B2' }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('conflict')
    expect(await db.select().from(businesses)).toHaveLength(1)
  })
})

describe('createPlatformAdmin', () => {
  beforeEach(resetDb)

  it('creates a platform admin with no membership', async () => {
    const { userId } = await createPlatformAdmin(db, {
      name: 'Root',
      email: 'Root@Platform.test',
      password: 'admin-pass-1',
    })
    const [user] = await db.select().from(users).where(eq(users.id, userId))
    expect(user).toMatchObject({ email: 'root@platform.test', isPlatformAdmin: true, mustChangePassword: false })
    expect(await db.select().from(memberships).where(eq(memberships.userId, userId))).toHaveLength(0)
  })

  it('rejects an invalid email or short password', async () => {
    await expect(
      createPlatformAdmin(db, { name: 'R', email: 'not-an-email', password: 'admin-pass-1' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      createPlatformAdmin(db, { name: 'R', email: 'r@p.test', password: 'short' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
