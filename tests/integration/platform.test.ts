import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, businesses, memberships, outlets, users } from '@/db/schema'
import { login } from '@/server/auth/login'
import { DomainError } from '@/server/errors'
import { createBusinessWithOwner, createPlatformAdmin, listBusinesses, platformAdminByEmail } from '@/server/services/platform'
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
    expect(user).toMatchObject({ email: 'root@platform.test', isPlatformAdmin: true, mustChangePassword: true })
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

describe('listBusinesses', () => {
  beforeEach(resetDb)

  it('counts each business’s own active outlets and staff', async () => {
    const a = await createBusinessWithOwner(db, {
      name: 'Alpha Hardware',
      ownerName: 'A',
      ownerEmail: 'a@alpha.test',
      ownerPassword: 'temp-pass-1',
    })
    await createBusinessWithOwner(db, {
      name: 'Beta Hardware',
      ownerName: 'B',
      ownerEmail: 'b@beta.test',
      ownerPassword: 'temp-pass-1',
    })
    await db.insert(outlets).values([
      { businessId: a.businessId, name: 'Kitale', code: 'KTL' },
      { businessId: a.businessId, name: 'Eldoret', code: 'ELD' },
      { businessId: a.businessId, name: 'Closed', code: 'CLS', active: false },
    ])

    const rows = await listBusinesses(db)
    expect(rows.map((r) => [r.name, r.outlets, r.staff])).toEqual([
      ['Alpha Hardware', 2, 1],
      ['Beta Hardware', 0, 1],
    ])
  })
})

describe('platform audit', () => {
  beforeEach(resetDb)

  it('records who created an admin or a business, and refuses a non-admin actor', async () => {
    const { userId: root } = await createPlatformAdmin(db, { name: 'Root', email: 'root@platform.test', password: 'admin-pass-1' })
    const { userId: second } = await createPlatformAdmin(db, {
      name: 'Second',
      email: 'second@platform.test',
      password: 'admin-pass-2',
      actorUserId: await platformAdminByEmail(db, 'ROOT@platform.test'),
    })
    const { businessId, ownerUserId } = await createBusinessWithOwner(db, {
      name: 'Audited Hardware',
      ownerName: 'Owner',
      ownerEmail: 'o@audited.test',
      ownerPassword: 'temp-pass-1',
      actorUserId: root,
    })
    const rows = await db.select().from(auditLog).orderBy(auditLog.seq)
    expect(rows.map((r) => [r.action, r.actorUserId])).toEqual([
      ['platform.create_admin', root],
      ['platform.create_admin', root],
      ['platform.create_business', root],
    ])
    expect(rows[1].entityId).toBe(second)
    expect(rows[2].businessId).toBe(businessId)
    await expect(
      createBusinessWithOwner(db, { name: 'X', ownerName: 'X', ownerEmail: 'x@x.test', ownerPassword: 'temp-pass-1', actorUserId: ownerUserId }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
