import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, memberships, outlets, users } from '@/db/schema'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'
import {
  createOutlet,
  listOutlets,
  setDefaultConnectionMode,
  updateOutlet,
} from '@/server/services/outlets'
import { resetDb, seedBusiness } from '../helpers/db'

async function ownerCtx(opts: Parameters<typeof seedBusiness>[0] = {}) {
  const seeded = await seedBusiness(opts)
  const ctx = (await getTenantCtx(db, seeded.owner.userId))!
  return { ...seeded, ctx }
}

async function memberCtx(businessId: string, role: 'manager' | 'cashier'): Promise<TenantCtx> {
  const [user] = await db
    .insert(users)
    .values({ name: role, email: `${role}-${crypto.randomUUID()}@t.test`, passwordHash: 'x' })
    .returning({ id: users.id })
  await db.insert(memberships).values({ businessId, userId: user.id, role })
  return (await getTenantCtx(db, user.id))!
}

describe('createOutlet', () => {
  beforeEach(resetDb)

  it('uppercases the code and resolves the effective mode to the business default', async () => {
    const { ctx, businessId } = await ownerCtx()
    const outlet = await createOutlet(db, ctx, { name: 'Kitale', code: 'ktl', connectionMode: null })
    expect(outlet).toMatchObject({
      name: 'Kitale',
      code: 'KTL',
      connectionMode: null,
      effectiveMode: 'default',
      active: true,
    })
    const [row] = await db.select().from(outlets).where(eq(outlets.id, outlet.id))
    expect(row).toMatchObject({ businessId, code: 'KTL' })
  })

  it('rejects a duplicate code (case-insensitive) within the business', async () => {
    const { ctx } = await ownerCtx({ outletCodes: ['MAIN'] })
    await expect(
      createOutlet(db, ctx, { name: 'Again', code: 'main', connectionMode: null }),
    ).rejects.toMatchObject({ code: 'duplicate_code' })
  })

  it('allows the same code in a different business', async () => {
    const { ctx } = await ownerCtx({ outletCodes: ['MAIN'] })
    const other = await ownerCtx()
    await createOutlet(db, other.ctx, { name: 'Main', code: 'MAIN', connectionMode: null })
    expect(await listOutlets(db, ctx)).toHaveLength(1)
  })

  it.each(['K', 'TOOLONG', 'AB-C', ''])('rejects the invalid code %j', async (code) => {
    const { ctx } = await ownerCtx()
    await expect(
      createOutlet(db, ctx, { name: 'X', code, connectionMode: null }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects a blank name', async () => {
    const { ctx } = await ownerCtx()
    await expect(
      createOutlet(db, ctx, { name: '  ', code: 'AB', connectionMode: null }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it.each(['manager', 'cashier'] as const)('forbids a %s', async (role) => {
    const { businessId } = await ownerCtx()
    const ctx = await memberCtx(businessId, role)
    await expect(
      createOutlet(db, ctx, { name: 'X', code: 'XX', connectionMode: null }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await db.select().from(outlets)).toHaveLength(0)
  })

  it('writes exactly one outlet.create audit row naming the actor', async () => {
    const { ctx, businessId } = await ownerCtx()
    const outlet = await createOutlet(db, ctx, { name: 'Kitale', code: 'KTL', connectionMode: 'full_offline' })
    const rows = await db.select().from(auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      businessId,
      actorUserId: ctx.userId,
      action: 'outlet.create',
      entityType: 'outlet',
      entityId: outlet.id,
    })
  })

  it('writes no audit row when the create fails', async () => {
    const { ctx } = await ownerCtx({ outletCodes: ['MAIN'] })
    await createOutlet(db, ctx, { name: 'Dup', code: 'MAIN', connectionMode: null }).catch(() => {})
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })
})

describe('setDefaultConnectionMode', () => {
  beforeEach(resetDb)

  it('changes the effective mode of outlets that use the default, not explicit ones', async () => {
    const { ctx } = await ownerCtx()
    const inherits = await createOutlet(db, ctx, { name: 'A', code: 'AA', connectionMode: null })
    const offline = await createOutlet(db, ctx, { name: 'B', code: 'BB', connectionMode: 'full_offline' })
    expect(inherits.effectiveMode).toBe('default')

    await setDefaultConnectionMode(db, ctx, 'always_online')

    const list = await listOutlets(db, ctx)
    expect(list.find((o) => o.id === inherits.id)).toMatchObject({
      connectionMode: null,
      effectiveMode: 'always_online',
    })
    expect(list.find((o) => o.id === offline.id)).toMatchObject({
      connectionMode: 'full_offline',
      effectiveMode: 'full_offline',
    })
  })

  it('is owner-only and audited as business.default_mode', async () => {
    const { ctx, businessId } = await ownerCtx()
    const manager = await memberCtx(businessId, 'manager')
    await expect(setDefaultConnectionMode(db, manager, 'always_online')).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(await db.select().from(auditLog)).toHaveLength(0)

    await setDefaultConnectionMode(db, ctx, 'always_online')
    const rows = await db.select().from(auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      businessId,
      actorUserId: ctx.userId,
      action: 'business.default_mode',
      entityType: 'business',
      entityId: businessId,
    })
  })

  it('rejects an unknown mode', async () => {
    const { ctx } = await ownerCtx()
    await expect(
      setDefaultConnectionMode(db, ctx, 'bogus' as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('updateOutlet', () => {
  beforeEach(resetDb)

  it('reports a malformed id as not_found', async () => {
    const { ctx } = await ownerCtx()
    await expect(updateOutlet(db, ctx, 'not-a-uuid', { name: 'X' })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('updates name, mode and active but never the code, with one audit row', async () => {
    const { ctx, businessId } = await ownerCtx()
    const created = await createOutlet(db, ctx, { name: 'Old', code: 'OLD', connectionMode: null })
    const updated = await updateOutlet(db, ctx, created.id, {
      name: ' New ',
      connectionMode: 'always_online',
      active: false,
      code: 'HACK',
    } as never)
    expect(updated).toMatchObject({
      name: 'New',
      code: 'OLD',
      connectionMode: 'always_online',
      effectiveMode: 'always_online',
      active: false,
    })
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'outlet.update'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ businessId, actorUserId: ctx.userId, entityId: created.id })
  })

  it('can reset the mode back to the business default with null', async () => {
    const { ctx } = await ownerCtx()
    const created = await createOutlet(db, ctx, { name: 'A', code: 'AA', connectionMode: 'full_offline' })
    const updated = await updateOutlet(db, ctx, created.id, { connectionMode: null })
    expect(updated).toMatchObject({ connectionMode: null, effectiveMode: 'default' })
  })

  it("reports another business's outlet as not_found and leaves it unchanged", async () => {
    const a = await ownerCtx()
    const b = await ownerCtx({ outletCodes: ['BEE'] })
    await expect(
      updateOutlet(db, a.ctx, b.outletIds[0], { name: 'Hijacked', active: false }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const [row] = await db.select().from(outlets).where(eq(outlets.id, b.outletIds[0]))
    expect(row).toMatchObject({ name: 'Outlet BEE', active: true })
    expect(await db.select().from(auditLog)).toHaveLength(0)
  })

  it('reports an unknown id as not_found', async () => {
    const { ctx } = await ownerCtx()
    await expect(
      updateOutlet(db, ctx, crypto.randomUUID(), { name: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('forbids a manager', async () => {
    const { businessId, outletIds } = await ownerCtx({ outletCodes: ['MAIN'] })
    const manager = await memberCtx(businessId, 'manager')
    await expect(
      updateOutlet(db, manager, outletIds[0], { name: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects a blank name and an unknown mode', async () => {
    const { ctx, outletIds } = await ownerCtx({ outletCodes: ['MAIN'] })
    await expect(updateOutlet(db, ctx, outletIds[0], { name: ' ' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(
      updateOutlet(db, ctx, outletIds[0], { connectionMode: 'bogus' as never }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('listOutlets', () => {
  beforeEach(resetDb)

  it("lists only the caller's business, ordered by code", async () => {
    const a = await ownerCtx({ outletCodes: ['ZED', 'ALP'] })
    await ownerCtx({ outletCodes: ['OTH'] })
    const list = await listOutlets(db, a.ctx)
    expect(list.map((o) => o.code)).toEqual(['ALP', 'ZED'])
  })

  it('includes inactive outlets for the owner', async () => {
    const { ctx, outletIds } = await ownerCtx({ outletCodes: ['MAIN', 'WEST'] })
    await updateOutlet(db, ctx, outletIds[1], { active: false })
    const list = await listOutlets(db, ctx)
    expect(list.map((o) => [o.code, o.active])).toEqual([
      ['MAIN', true],
      ['WEST', false],
    ])
  })

  it('shows managers and cashiers only the outlets in their scope', async () => {
    const { businessId, outletIds } = await ownerCtx({ outletCodes: ['MAIN', 'WEST'] })
    const [user] = await db
      .insert(users)
      .values({ name: 'm', email: 'm@t.test', passwordHash: 'x' })
      .returning({ id: users.id })
    const [membership] = await db
      .insert(memberships)
      .values({ businessId, userId: user.id, role: 'manager' })
      .returning({ id: memberships.id })
    const { membershipOutlets } = await import('@/db/schema')
    await db.insert(membershipOutlets).values({ membershipId: membership.id, outletId: outletIds[1], businessId })
    const ctx = (await getTenantCtx(db, user.id))!
    const list = await listOutlets(db, ctx)
    expect(list.map((o) => o.code)).toEqual(['WEST'])
  })

  it('returns nothing for a member with an empty scope', async () => {
    const { businessId } = await ownerCtx({ outletCodes: ['MAIN'] })
    const cashier = await memberCtx(businessId, 'cashier')
    expect(await listOutlets(db, cashier)).toEqual([])
  })
})
