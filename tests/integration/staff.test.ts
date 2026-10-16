import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, membershipOutlets, memberships, users } from '@/db/schema'
import { login } from '@/server/auth/login'
import { verifySecret } from '@/server/auth/secret'
import { validateSession } from '@/server/auth/session'
import {
  createStaff,
  deactivateStaff,
  listStaff,
  setPin,
  updateStaff,
  type StaffMember,
} from '@/server/services/staff'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

const TEMP_PASSWORD = 'temp-pass-1234'

async function setup(outletCodes = ['KTL', 'ELD']) {
  const seeded = await seedBusiness({ outletCodes })
  const ctx = (await getTenantCtx(db, seeded.owner.userId))!
  const [ktl, eld] = seeded.outletIds
  return { ...seeded, ctx, ktl, eld }
}

let counter = 0
async function hire(
  ctx: TenantCtx,
  role: 'owner' | 'manager' | 'cashier',
  outletIds: string[],
): Promise<{ member: StaffMember; ctx: TenantCtx }> {
  counter += 1
  const member = await createStaff(db, ctx, {
    name: `${role} ${counter}`,
    email: `${role}${counter}@staff.test`,
    role,
    outletIds,
    tempPassword: TEMP_PASSWORD,
  })
  return { member, ctx: (await getTenantCtx(db, member.userId))! }
}

describe('createStaff', () => {
  beforeEach(resetDb)

  it('creates a cashier by local phone, stored as E.164, forced to change the password', async () => {
    const { ctx, ktl, businessId } = await setup()
    const member = await createStaff(db, ctx, {
      name: '  Wanjiru ',
      phone: '0712345678',
      role: 'cashier',
      outletIds: [ktl],
      tempPassword: TEMP_PASSWORD,
    })
    expect(member).toMatchObject({
      name: 'Wanjiru',
      phone: '+254712345678',
      email: null,
      role: 'cashier',
      outletIds: [ktl],
      active: true,
      hasPin: false,
    })
    const [user] = await db.select().from(users).where(eq(users.id, member.userId))
    expect(user).toMatchObject({ phone: '+254712345678', mustChangePassword: true })
    expect(user.passwordHash).not.toContain(TEMP_PASSWORD)
    expect(await verifySecret(user.passwordHash, TEMP_PASSWORD)).toBe(true)
    const links = await db.select().from(membershipOutlets).where(eq(membershipOutlets.membershipId, member.membershipId))
    expect(links).toMatchObject([{ businessId, outletId: ktl }])
  })

  it('trims and lowercases the email', async () => {
    const { ctx, ktl } = await setup()
    const member = await createStaff(db, ctx, {
      name: 'A',
      email: '  Till.One@Example.COM ',
      role: 'cashier',
      outletIds: [ktl],
      tempPassword: TEMP_PASSWORD,
    })
    expect(member.email).toBe('till.one@example.com')
  })

  it('lets the new cashier log in with the temporary password', async () => {
    const { ctx, ktl } = await setup()
    await createStaff(db, ctx, {
      name: 'A',
      phone: '0712345678',
      role: 'cashier',
      outletIds: [ktl],
      tempPassword: TEMP_PASSWORD,
    })
    const result = await login(db, { identifier: '0712345678', password: TEMP_PASSWORD })
    expect(result).toMatchObject({ ok: true, mustChangePassword: true })
  })

  it('rejects a cashier or manager with no outlets', async () => {
    const { ctx } = await setup()
    for (const role of ['cashier', 'manager'] as const) {
      await expect(
        createStaff(db, ctx, { name: 'A', phone: '0712345678', role, outletIds: [], tempPassword: TEMP_PASSWORD }),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('allows an owner with no outlets', async () => {
    const { ctx } = await setup()
    const member = await createStaff(db, ctx, {
      name: 'Co-owner',
      email: 'co@staff.test',
      role: 'owner',
      outletIds: [],
      tempPassword: TEMP_PASSWORD,
    })
    expect(member).toMatchObject({ role: 'owner', outletIds: [] })
  })

  it('rejects missing contact, bad phone, bad email, short password, blank name, bad role', async () => {
    const { ctx, ktl } = await setup()
    const base = { name: 'A', role: 'cashier' as const, outletIds: [ktl], tempPassword: TEMP_PASSWORD }
    const bad = [
      { ...base },
      { ...base, phone: '12345' },
      { ...base, email: 'not-an-email' },
      { ...base, phone: '0712345678', tempPassword: 'short' },
      { ...base, phone: '0712345678', name: '   ' },
      { ...base, phone: '0712345678', role: 'admin' as 'owner' },
    ]
    for (const input of bad) {
      await expect(createStaff(db, ctx, input)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(await db.select().from(memberships)).toHaveLength(1)
  })

  it('reports an outlet of another business as not_found and creates nothing', async () => {
    const { ctx } = await setup()
    const other = await setup(['OTH'])
    await expect(
      createStaff(db, ctx, {
        name: 'A',
        phone: '0712345678',
        role: 'cashier',
        outletIds: [other.ktl],
        tempPassword: TEMP_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await db.select().from(users)).toHaveLength(2)
  })

  it('reports an inactive outlet as not_found', async () => {
    const { ctx, ktl } = await setup()
    await db.execute(sql`update outlets set active = false where id = ${ktl}`)
    await expect(
      createStaff(db, ctx, {
        name: 'A',
        phone: '0712345678',
        role: 'cashier',
        outletIds: [ktl],
        tempPassword: TEMP_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reports a phone or email already in use as conflict, and rolls back', async () => {
    const { ctx, ktl } = await setup()
    await createStaff(db, ctx, {
      name: 'A',
      phone: '0712345678',
      email: 'a@staff.test',
      role: 'cashier',
      outletIds: [ktl],
      tempPassword: TEMP_PASSWORD,
    })
    await expect(
      createStaff(db, ctx, {
        name: 'B',
        phone: '+254 712 345 678',
        role: 'cashier',
        outletIds: [ktl],
        tempPassword: TEMP_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      createStaff(db, ctx, {
        name: 'B',
        email: 'A@Staff.test',
        role: 'cashier',
        outletIds: [ktl],
        tempPassword: TEMP_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await db.select().from(users)).toHaveLength(2)
    expect(await db.select().from(auditLog)).toHaveLength(1)
  })

  it.each(['manager', 'cashier'] as const)('forbids a %s', async (role) => {
    const { ctx, ktl } = await setup()
    const actor = await hire(ctx, role, [ktl])
    await expect(
      createStaff(db, actor.ctx, {
        name: 'X',
        phone: '0722222222',
        role: 'cashier',
        outletIds: [ktl],
        tempPassword: TEMP_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('audits the creation without contact details or secrets', async () => {
    const { ctx, ktl, businessId } = await setup()
    const member = await createStaff(db, ctx, {
      name: 'Wanjiru',
      phone: '0712345678',
      role: 'cashier',
      outletIds: [ktl],
      tempPassword: TEMP_PASSWORD,
    })
    const rows = await db.select().from(auditLog)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      businessId,
      actorUserId: ctx.userId,
      action: 'staff.create',
      entityType: 'membership',
      entityId: member.membershipId,
      data: { name: 'Wanjiru', role: 'cashier', outletIds: [ktl] },
    })
    expect(JSON.stringify(rows[0])).not.toContain(TEMP_PASSWORD)
    expect(JSON.stringify(rows[0])).not.toContain('712345678')
  })
})

describe('listStaff', () => {
  beforeEach(resetDb)

  it('shows the owner everyone in their business only', async () => {
    const { ctx, ktl, eld } = await setup()
    await hire(ctx, 'cashier', [ktl])
    await hire(ctx, 'manager', [eld])
    const other = await setup(['OTH'])
    await hire(other.ctx, 'cashier', [other.ktl])

    const list = await listStaff(db, ctx)
    expect(list.map((s) => s.role).sort()).toEqual(['cashier', 'manager', 'owner'])
  })

  it('shows a manager only themself and staff sharing one of their outlets', async () => {
    const { ctx, ktl, eld } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const both = await hire(ctx, 'cashier', [ktl, eld])
    const eldOnly = await hire(ctx, 'cashier', [eld])
    const ktlOnly = await hire(ctx, 'cashier', [ktl])

    const ids = (await listStaff(db, mgr.ctx)).map((s) => s.membershipId)
    expect(ids.sort()).toEqual(
      [mgr.member.membershipId, both.member.membershipId, ktlOnly.member.membershipId].sort(),
    )
    expect(ids).not.toContain(eldOnly.member.membershipId)
    expect(ids).not.toContain(ctx.membershipId)
  })

  it('forbids a cashier', async () => {
    const { ctx, ktl } = await setup()
    const cashier = await hire(ctx, 'cashier', [ktl])
    await expect(listStaff(db, cashier.ctx)).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('updateStaff', () => {
  beforeEach(resetDb)

  it('changes role and replaces outlets', async () => {
    const { ctx, ktl, eld } = await setup()
    const { member } = await hire(ctx, 'cashier', [ktl])
    const updated = await updateStaff(db, ctx, member.membershipId, { role: 'manager', outletIds: [eld] })
    expect(updated).toMatchObject({ role: 'manager', outletIds: [eld] })
    const links = await db.select().from(membershipOutlets).where(eq(membershipOutlets.membershipId, member.membershipId))
    expect(links.map((l) => l.outletId)).toEqual([eld])
  })

  it('validates the resulting state', async () => {
    const { ctx, ktl } = await setup()
    const { member } = await hire(ctx, 'cashier', [ktl])
    await expect(updateStaff(db, ctx, member.membershipId, { outletIds: [] })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    const other = await setup(['OTH'])
    await expect(
      updateStaff(db, ctx, member.membershipId, { outletIds: [other.ktl] }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const [row] = await db.select().from(memberships).where(eq(memberships.id, member.membershipId))
    expect(row.role).toBe('cashier')
    const links = await db.select().from(membershipOutlets).where(eq(membershipOutlets.membershipId, member.membershipId))
    expect(links.map((l) => l.outletId)).toEqual([ktl])
  })

  it('refuses to demote the last active owner but allows it with another owner', async () => {
    const { ctx, ktl } = await setup()
    await expect(
      updateStaff(db, ctx, ctx.membershipId, { role: 'manager', outletIds: [ktl] }),
    ).rejects.toMatchObject({ code: 'conflict' })

    const coOwner = await hire(ctx, 'owner', [])
    const demoted = await updateStaff(db, ctx, ctx.membershipId, { role: 'manager', outletIds: [ktl] })
    expect(demoted.role).toBe('manager')
    // coOwner is now the last active owner.
    await expect(
      updateStaff(db, coOwner.ctx, coOwner.member.membershipId, { role: 'manager', outletIds: [ktl] }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('forbids managers and cashiers', async () => {
    const { ctx, ktl } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const cashier = await hire(ctx, 'cashier', [ktl])
    await expect(
      updateStaff(db, mgr.ctx, cashier.member.membershipId, { role: 'manager' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('reports another business membership as not_found', async () => {
    const a = await setup()
    const b = await setup(['OTH'])
    const target = await hire(b.ctx, 'cashier', [b.ktl])
    await expect(
      updateStaff(db, a.ctx, target.member.membershipId, { role: 'manager', outletIds: [a.ktl] }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const [row] = await db.select().from(memberships).where(eq(memberships.id, target.member.membershipId))
    expect(row.role).toBe('cashier')
  })

  it('audits the change with before and after', async () => {
    const { ctx, ktl, eld } = await setup()
    const { member } = await hire(ctx, 'cashier', [ktl])
    await updateStaff(db, ctx, member.membershipId, { role: 'manager', outletIds: [eld] })
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'staff.update'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorUserId: ctx.userId,
      entityType: 'membership',
      entityId: member.membershipId,
      data: {
        before: { role: 'cashier', outletIds: [ktl] },
        after: { role: 'manager', outletIds: [eld] },
      },
    })
  })
})

describe('deactivateStaff', () => {
  beforeEach(resetDb)

  it('deactivates a cashier and revokes their sessions and tenant access', async () => {
    const { ctx, ktl, businessId } = await setup()
    const { member } = await hire(ctx, 'cashier', [ktl])
    const result = await login(db, { identifier: `cashier${counter}@staff.test`, password: TEMP_PASSWORD })
    if (!result.ok) throw new Error('expected login')
    expect(await validateSession(db, result.token)).not.toBeNull()

    await deactivateStaff(db, ctx, member.membershipId)

    expect(await validateSession(db, result.token)).toBeNull()
    expect(await getTenantCtx(db, member.userId)).toBeNull()
    const again = await login(db, { identifier: `cashier${counter}@staff.test`, password: TEMP_PASSWORD })
    expect(again).toMatchObject({ ok: false })
    const list = await listStaff(db, ctx)
    expect(list.find((s) => s.membershipId === member.membershipId)?.active).toBe(false)
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'staff.deactivate'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ businessId, actorUserId: ctx.userId, entityId: member.membershipId })
  })

  it('refuses to deactivate yourself', async () => {
    const { ctx } = await setup()
    await expect(deactivateStaff(db, ctx, ctx.membershipId)).rejects.toMatchObject({ code: 'conflict' })
    expect(await getTenantCtx(db, ctx.userId)).not.toBeNull()
  })

  it('refuses to deactivate the last active owner', async () => {
    const { ctx } = await setup()
    const coOwner = await hire(ctx, 'owner', [])
    await deactivateStaff(db, coOwner.ctx, ctx.membershipId)
    // ctx is now stale (deactivated); coOwner is the last active owner.
    await expect(
      deactivateStaff(db, ctx, coOwner.member.membershipId),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await getTenantCtx(db, coOwner.member.userId)).not.toBeNull()
  })

  it('forbids a manager', async () => {
    const { ctx, ktl } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const cashier = await hire(ctx, 'cashier', [ktl])
    await expect(deactivateStaff(db, mgr.ctx, cashier.member.membershipId)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('reports another business membership as not_found and leaves it active', async () => {
    const a = await setup()
    const b = await setup(['OTH'])
    const target = await hire(b.ctx, 'cashier', [b.ktl])
    await expect(deactivateStaff(db, a.ctx, target.member.membershipId)).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(await getTenantCtx(db, target.member.userId)).not.toBeNull()
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'staff.deactivate'))).toHaveLength(0)
  })
})

describe('setPin', () => {
  beforeEach(resetDb)

  it.each(['12a4', '123', '1234567', '', ' 1234'])('rejects the invalid PIN %j', async (pin) => {
    const { ctx, ktl } = await setup()
    const { member } = await hire(ctx, 'cashier', [ktl])
    await expect(setPin(db, ctx, member.membershipId, pin)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('lets the owner set a PIN, stored hashed', async () => {
    const { ctx, ktl } = await setup()
    const { member } = await hire(ctx, 'cashier', [ktl])
    await setPin(db, ctx, member.membershipId, '1234')
    const [row] = await db.select().from(memberships).where(eq(memberships.id, member.membershipId))
    expect(row.pinHash).not.toBeNull()
    expect(row.pinHash).not.toContain('1234')
    expect(await verifySecret(row.pinHash!, '1234')).toBe(true)
    const list = await listStaff(db, ctx)
    expect(list.find((s) => s.membershipId === member.membershipId)?.hasPin).toBe(true)
  })

  it('lets a manager set the PIN of a cashier in their outlet', async () => {
    const { ctx, ktl, eld } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const cashier = await hire(ctx, 'cashier', [ktl, eld])
    await setPin(db, mgr.ctx, cashier.member.membershipId, '654321')
    const list = await listStaff(db, mgr.ctx)
    expect(list.find((s) => s.membershipId === cashier.member.membershipId)?.hasPin).toBe(true)
  })

  it('forbids a manager from a cashier in another outlet, a manager, or the owner', async () => {
    const { ctx, ktl, eld } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const elsewhere = await hire(ctx, 'cashier', [eld])
    const peer = await hire(ctx, 'manager', [ktl])
    for (const target of [elsewhere.member.membershipId, peer.member.membershipId, ctx.membershipId, mgr.member.membershipId]) {
      await expect(setPin(db, mgr.ctx, target, '1234')).rejects.toMatchObject({ code: 'forbidden' })
    }
    const rows = await db.select().from(memberships).where(eq(memberships.userId, elsewhere.member.userId))
    expect(rows[0].pinHash).toBeNull()
  })

  it('forbids a manager from a deactivated cashier', async () => {
    const { ctx, ktl } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const cashier = await hire(ctx, 'cashier', [ktl])
    await deactivateStaff(db, ctx, cashier.member.membershipId)
    await expect(setPin(db, mgr.ctx, cashier.member.membershipId, '1234')).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('forbids a cashier', async () => {
    const { ctx, ktl } = await setup()
    const a = await hire(ctx, 'cashier', [ktl])
    const b = await hire(ctx, 'cashier', [ktl])
    await expect(setPin(db, a.ctx, b.member.membershipId, '1234')).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('reports another business membership as not_found, even for owners and managers', async () => {
    const a = await setup()
    const b = await setup(['OTH'])
    const target = await hire(b.ctx, 'cashier', [b.ktl])
    const mgr = await hire(a.ctx, 'manager', [a.ktl])
    await expect(setPin(db, a.ctx, target.member.membershipId, '1234')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(setPin(db, mgr.ctx, target.member.membershipId, '1234')).rejects.toMatchObject({
      code: 'not_found',
    })
    const [row] = await db.select().from(memberships).where(eq(memberships.id, target.member.membershipId))
    expect(row.pinHash).toBeNull()
  })

  it('audits the PIN change without the PIN or its hash', async () => {
    const { ctx, ktl, businessId } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const { member } = await hire(ctx, 'cashier', [ktl])
    await setPin(db, mgr.ctx, member.membershipId, '482913')
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'staff.set_pin'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      businessId,
      actorUserId: mgr.ctx.userId,
      entityType: 'membership',
      entityId: member.membershipId,
    })
    const [m] = await db.select().from(memberships).where(eq(memberships.id, member.membershipId))
    const serialized = JSON.stringify(rows[0])
    expect(serialized).not.toContain('482913')
    expect(serialized).not.toContain(m.pinHash!)
  })
})
