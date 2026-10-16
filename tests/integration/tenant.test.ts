import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { businesses, membershipOutlets, memberships, outlets, users } from '@/db/schema'
import { DomainError } from '@/server/errors'
import { assertCan, getTenantCtx, type TenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

async function addMember(
  businessId: string,
  role: 'manager' | 'cashier',
  outletIds: string[],
  opts: { active?: boolean } = {},
) {
  const [user] = await db
    .insert(users)
    .values({ name: `${role} user`, email: `${role}-${crypto.randomUUID()}@t.test`, passwordHash: 'x' })
    .returning({ id: users.id })
  const [membership] = await db
    .insert(memberships)
    .values({ businessId, userId: user.id, role, active: opts.active ?? true })
    .returning({ id: memberships.id })
  if (outletIds.length) {
    await db
      .insert(membershipOutlets)
      .values(outletIds.map((outletId) => ({ membershipId: membership.id, outletId, businessId })))
  }
  return { userId: user.id, membershipId: membership.id }
}

describe('getTenantCtx', () => {
  beforeEach(resetDb)

  it('gives an owner access to all outlets', async () => {
    const { businessId, owner } = await seedBusiness({ outletCodes: ['MAIN', 'WEST'] })
    expect(await getTenantCtx(db, owner.userId)).toEqual({
      userId: owner.userId,
      businessId,
      membershipId: owner.membershipId,
      role: 'owner',
      outletScope: 'all',
    })
  })

  it('scopes a cashier to the outlets they are assigned to', async () => {
    const { businessId, outletIds } = await seedBusiness({ outletCodes: ['MAIN', 'WEST'] })
    const cashier = await addMember(businessId, 'cashier', [outletIds[1]])
    const ctx = await getTenantCtx(db, cashier.userId)
    expect(ctx).toEqual({
      userId: cashier.userId,
      businessId,
      membershipId: cashier.membershipId,
      role: 'cashier',
      outletScope: [outletIds[1]],
    })
  })

  it('gives a manager every assigned outlet', async () => {
    const { businessId, outletIds } = await seedBusiness({ outletCodes: ['MAIN', 'WEST', 'EAST'] })
    const manager = await addMember(businessId, 'manager', [outletIds[0], outletIds[2]])
    const ctx = await getTenantCtx(db, manager.userId)
    expect(ctx?.role).toBe('manager')
    expect([...(ctx?.outletScope as string[])].sort()).toEqual([outletIds[0], outletIds[2]].sort())
  })

  it('gives an unassigned cashier an empty scope', async () => {
    const { businessId } = await seedBusiness({ outletCodes: ['MAIN'] })
    const cashier = await addMember(businessId, 'cashier', [])
    expect((await getTenantCtx(db, cashier.userId))?.outletScope).toEqual([])
  })

  it("never puts another business's outlet into the scope", async () => {
    const a = await seedBusiness({ outletCodes: ['MAIN'] })
    const b = await seedBusiness({ outletCodes: ['OTHR'] })
    const cashier = await addMember(a.businessId, 'cashier', [a.outletIds[0]])
    // Bad row: the schema has no composite FK, so B's outlet can be linked under A's business.
    await db.insert(membershipOutlets).values({
      membershipId: cashier.membershipId,
      outletId: b.outletIds[0],
      businessId: a.businessId,
    })
    const ctx = await getTenantCtx(db, cashier.userId)
    expect(ctx?.outletScope).toEqual([a.outletIds[0]])
    expect(ctx?.outletScope).not.toContain(b.outletIds[0])
  })

  it('excludes inactive outlets from the scope', async () => {
    const { businessId, outletIds } = await seedBusiness({ outletCodes: ['MAIN', 'WEST'] })
    const cashier = await addMember(businessId, 'cashier', outletIds)
    await db.update(outlets).set({ active: false }).where(eq(outlets.id, outletIds[1]))
    expect((await getTenantCtx(db, cashier.userId))?.outletScope).toEqual([outletIds[0]])
  })

  it('returns null for an inactive membership', async () => {
    const { businessId, outletIds } = await seedBusiness({ outletCodes: ['MAIN'] })
    const cashier = await addMember(businessId, 'cashier', [outletIds[0]], { active: false })
    expect(await getTenantCtx(db, cashier.userId)).toBeNull()
  })

  it('returns null when the business is suspended', async () => {
    const { businessId, owner } = await seedBusiness({ outletCodes: ['MAIN'] })
    await db.update(businesses).set({ status: 'suspended' }).where(eq(businesses.id, businessId))
    expect(await getTenantCtx(db, owner.userId)).toBeNull()
  })

  it('returns null for a platform admin with no membership', async () => {
    const [admin] = await db
      .insert(users)
      .values({ name: 'Admin', email: 'admin@platform.test', passwordHash: 'x', isPlatformAdmin: true })
      .returning({ id: users.id })
    expect(await getTenantCtx(db, admin.id)).toBeNull()
  })

  it('returns null for an unknown user', async () => {
    expect(await getTenantCtx(db, crypto.randomUUID())).toBeNull()
  })
})

describe('assertCan', () => {
  const ctx = (role: TenantCtx['role']): TenantCtx => ({
    userId: 'u',
    businessId: 'b',
    membershipId: 'm',
    role,
    outletScope: role === 'owner' ? 'all' : [],
  })

  it('passes when the role may perform the action', () => {
    expect(() => assertCan(ctx('owner'), 'staff.manage')).not.toThrow()
    expect(() => assertCan(ctx('manager'), 'staff.reset_pin')).not.toThrow()
  })

  it('throws DomainError forbidden otherwise', () => {
    for (const role of ['manager', 'cashier'] as const) {
      try {
        assertCan(ctx(role), 'staff.manage')
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError)
        expect((e as DomainError).code).toBe('forbidden')
      }
    }
  })
})
