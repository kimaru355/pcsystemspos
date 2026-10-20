import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, devices, memberships, outletStock, stockMovements, syncOps, users } from '@/db/schema'
import { checkPin } from '@/domain/pin'
import { authenticateDevice, listDevices, registerDevice, revokeDevice } from '@/server/services/devices'
import { deactivateStaff, updateStaff } from '@/server/services/staff'
import { applyOp, sync } from '@/server/services/sync'
import { tillSignIn } from '@/server/services/till-auth'
import { getTenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'
import { adjustOp, CLOCK, hire, tillWorld, uuid } from './till-helpers'

async function onHand(outletId: string, itemId: string) {
  const [r] = await db
    .select()
    .from(outletStock)
    .where(and(eq(outletStock.outletId, outletId), eq(outletStock.itemId, itemId)))
  return r
}

describe('devices', () => {
  beforeEach(resetDb)

  it('registers tills with the next two-digit number per outlet and audits it', async () => {
    const w = await tillWorld()
    const second = await registerDevice(db, w.owner, { outletId: w.ktl, name: 'Back office' })
    const other = await registerDevice(db, w.owner, { outletId: w.eld, name: 'ELD till' })
    expect([w.device.code, second.code, other.code]).toEqual(['01', '02', '01'])
    const [a] = await db.select().from(auditLog).where(eq(auditLog.entityId, second.deviceId))
    expect(a.action).toBe('device.register')
    // The token is never stored, only its hash.
    const [row] = await db.select().from(devices).where(eq(devices.id, second.deviceId))
    expect(row.tokenHash).not.toContain(second.token)
  })

  it('managers register and revoke only for their outlets; cashiers never', async () => {
    const w = await tillWorld()
    await expect(registerDevice(db, w.manager.ctx, { outletId: w.eld, name: 'X' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(registerDevice(db, w.cashier.ctx, { outletId: w.ktl, name: 'X' })).rejects.toMatchObject({ code: 'forbidden' })
    const other = await seedBusiness({ outletCodes: ['NRB'] })
    await expect(registerDevice(db, w.owner, { outletId: other.outletIds[0], name: 'X' })).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(registerDevice(db, w.owner, { outletId: w.ktl, name: '  ' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a revoked till can no longer authenticate', async () => {
    const w = await tillWorld()
    await revokeDevice(db, w.manager.ctx, w.device.deviceId)
    expect(await authenticateDevice(db, w.token)).toEqual({ ok: false, reason: 'revoked' })
    expect(await authenticateDevice(db, 'nope')).toEqual({ ok: false, reason: 'unknown' })
    await expect(revokeDevice(db, w.owner, w.device.deviceId)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('lists devices with last sync and flags those past the reminder point', async () => {
    const w = await tillWorld()
    await sync(db, w.device, { ops: [], hashes: {}, clock: { jumps: 2, lastJumpAt: new Date().toISOString() } })
    const [d] = await listDevices(db, w.owner)
    expect(d).toMatchObject({ code: '01', pastReminder: false, clockJumps: 2 })
    expect(d.lastSyncAt).toBeInstanceOf(Date)
    const later = new Date(Date.now() + 2 * 24 * 3600 * 1000)
    expect((await listDevices(db, w.owner, later))[0].pastReminder).toBe(true)
  })
})

describe('tillSignIn', () => {
  beforeEach(resetDb)

  async function withPassword() {
    const w = await tillWorld()
    // Hired staff must change the temporary password before using a till: pretend they did.
    await db.update(users).set({ mustChangePassword: false })
    return w
  }

  it('signs in with password and PIN and returns the offline verifier', async () => {
    const w = await withPassword()
    const s = await tillSignIn(db, w.device, { identifier: w.cashier.email!, password: 'temp-pass-1234', pin: '1111' })
    expect(s).toMatchObject({ membershipId: w.cashier.membershipId, role: 'cashier' })
    expect(await checkPin('1111', s.pin!)).toBe(true)
  })

  it('refuses a wrong PIN, a wrong password and someone not assigned to the outlet', async () => {
    const w = await withPassword()
    const input = { identifier: w.cashier.email!, password: 'temp-pass-1234', pin: '9999' }
    await expect(tillSignIn(db, w.device, input)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(tillSignIn(db, w.device, { ...input, pin: '1111', password: 'wrong-password' })).rejects.toMatchObject({
      code: 'forbidden',
    })
    const eldOnly = await hire(w.owner, 'cashier', [w.eld], '3333')
    await db.update(users).set({ mustChangePassword: false })
    await expect(
      tillSignIn(db, w.device, { identifier: eldOnly.email!, password: 'temp-pass-1234', pin: '3333' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'You are not assigned to Outlet KTL.' })
  })

  it('lets someone without a PIN choose one, and audits it', async () => {
    const w = await withPassword()
    await db.update(memberships).set({ pinHash: null, pinSalt: null, pinVerifier: null }).where(eq(memberships.id, w.cashier.membershipId))
    const s = await tillSignIn(db, w.device, { identifier: w.cashier.email!, password: 'temp-pass-1234', pin: '4567' })
    expect(await checkPin('4567', s.pin!)).toBe(true)
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'staff.set_own_pin'))
    expect(rows).toHaveLength(1)
    expect(rows[0].deviceId).toBe(w.device.deviceId)
  })

  it('asks for the temporary password to be changed first', async () => {
    const w = await tillWorld()
    await expect(
      tillSignIn(db, w.device, { identifier: w.cashier.email!, password: 'temp-pass-1234', pin: '1111' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('sync push', () => {
  beforeEach(resetDb)

  it('applies an op exactly once, however often it is pushed', async () => {
    const w = await tillWorld()
    const op = adjustOp(w, -3000)
    const first = await sync(db, w.device, { ops: [op], hashes: {}, clock: CLOCK })
    const again = await sync(db, w.device, { ops: [op, op], hashes: {}, clock: CLOCK })
    expect(first.results).toEqual([{ id: op.id, status: 'applied' }])
    expect(again.results).toEqual([
      { id: op.id, status: 'applied' },
      { id: op.id, status: 'applied' },
    ])
    expect((await onHand(w.ktl, w.cement.id)).onHandMilli).toBe(97000)
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.kind, 'adjust'))
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({ deviceId: w.device.deviceId, actorUserId: w.manager.userId })
  })

  it('applies concurrent pushes of the same op once', async () => {
    const w = await tillWorld()
    const op = adjustOp(w, -1000)
    const rs = await Promise.all([1, 2, 3].map(() => applyOp(db, w.device, op)))
    expect(rs.every((r) => r.status === 'applied')).toBe(true)
    expect((await onHand(w.ktl, w.cement.id)).onHandMilli).toBe(99000)
  })

  it('stores a rejected op with its payload and returns the same answer on retry', async () => {
    const w = await tillWorld()
    const op = adjustOp(w, -1000, w.cashier.membershipId) // cashiers cannot adjust
    const r1 = await applyOp(db, w.device, op)
    const r2 = await applyOp(db, w.device, op)
    expect(r1).toMatchObject({ status: 'rejected', code: 'forbidden' })
    expect(r2).toEqual(r1)
    const [row] = await db.select().from(syncOps).where(eq(syncOps.id, op.id))
    expect(row).toMatchObject({ status: 'rejected', type: 'stock.adjust' })
    expect(row.payload).toMatchObject({ deltaMilli: -1000 })
    expect((await onHand(w.ktl, w.cement.id)).onHandMilli).toBe(100000)
  })

  it('rejects an unreadable op on its own and keeps going', async () => {
    const w = await tillWorld()
    const bad = { id: uuid(), type: 'stock.adjust', actorId: 'x', occurredAt: 'now', payload: {} }
    const good = adjustOp(w, -1000)
    const r = await sync(db, w.device, { ops: [bad, good], hashes: {}, clock: CLOCK })
    expect(r.results.map((x) => x.status)).toEqual(['rejected', 'applied'])
    expect((await db.select().from(syncOps).where(eq(syncOps.id, bad.id)))[0].status).toBe('rejected')
  })

  it('takes a till adjustment below zero and flags the item', async () => {
    const w = await tillWorld()
    await applyOp(db, w.device, adjustOp(w, -150000))
    const r = await onHand(w.ktl, w.cement.id)
    expect(r.onHandMilli).toBe(-50000)
    expect(r.flaggedNegativeAt).toBeInstanceOf(Date)
  })

  it('a movement id reused by another op is rejected, not a server error', async () => {
    const w = await tillWorld()
    const a = adjustOp(w, -1000)
    const b = { ...adjustOp(w, -1000), payload: { ...(a.payload as object), deltaMilli: -2000 } } as typeof a
    expect((await applyOp(db, w.device, a)).status).toBe('applied')
    expect(await applyOp(db, w.device, b)).toMatchObject({ status: 'rejected', code: 'conflict' })
  })

  it('refuses an actor from another business', async () => {
    const w = await tillWorld()
    const other = await seedBusiness()
    const r = await applyOp(db, w.device, adjustOp(w, -1000, other.owner.membershipId))
    expect(r).toMatchObject({ status: 'rejected', code: 'forbidden' })
  })

  it("never reveals another business's op result", async () => {
    const w = await tillWorld()
    const op = adjustOp(w, -1000)
    await applyOp(db, w.device, op)
    const other = await seedBusiness({ outletCodes: ['NRB'] })
    const otherOwner = (await getTenantCtx(db, other.owner.userId))!
    const reg = await registerDevice(db, otherOwner, { outletId: other.outletIds[0], name: 'T' })
    const auth = await authenticateDevice(db, reg.token)
    if (!auth.ok) throw new Error()
    expect(await applyOp(db, auth.device, { ...op, actorId: other.owner.membershipId })).toMatchObject({
      status: 'rejected',
      code: 'conflict',
    })
  })

  it('clamps a future time to the server time and keeps the till time in audit rows', async () => {
    const w = await tillWorld()
    const op = { ...adjustOp(w, -1000), occurredAt: new Date(Date.now() + 3600_000).toISOString() }
    const now = new Date()
    await applyOp(db, w.device, op, now)
    const [m] = await db.select().from(stockMovements).where(eq(stockMovements.kind, 'adjust'))
    expect(m.occurredAt.getTime()).toBe(now.getTime())
    const [a] = await db.select().from(auditLog).where(eq(auditLog.opId, op.id))
    expect(a).toMatchObject({ action: 'stock.adjust', deviceId: w.device.deviceId })
  })
})

describe('sync pull', () => {
  beforeEach(resetDb)

  it('sends every section first, then only those that changed', async () => {
    const w = await tillWorld()
    const r1 = await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })
    expect(Object.keys(r1.sections).sort()).toEqual(['catalog', 'orders', 'staff', 'stock'])
    expect(r1.settings).toMatchObject({
      outlet: { code: 'KTL', active: true },
      device: { code: '01' },
      mode: 'default',
      lastOrderSeq: 0,
    })
    const catalog = r1.sections.catalog!.data
    expect(catalog.items.map((i) => i.name).sort()).toEqual(['Cement 50kg', 'Iron sheet 30G'])
    expect(catalog.packs).toHaveLength(1)
    expect(r1.sections.stock!.data.onHand).toHaveLength(2)
    expect(r1.sections.staff!.data.staff.map((s) => s.role).sort()).toEqual(['cashier', 'manager', 'owner'])

    const hashes = Object.fromEntries(Object.entries(r1.sections).map(([k, v]) => [k, v!.hash]))
    const r2 = await sync(db, w.device, { ops: [adjustOp(w, -1000)], hashes, clock: CLOCK })
    expect(Object.keys(r2.sections)).toEqual(['stock'])
  })

  it('sends PIN verifiers only for people who signed in on this till', async () => {
    const w = await tillWorld()
    await db.update(users).set({ mustChangePassword: false })
    let r = await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })
    expect(r.sections.staff!.data.staff.every((s) => s.pin === null)).toBe(true)
    await tillSignIn(db, w.device, { identifier: w.manager.email!, password: 'temp-pass-1234', pin: '2222' })
    r = await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })
    const withPin = r.sections.staff!.data.staff.filter((s) => s.pin !== null).map((s) => s.membershipId)
    expect(withPin).toEqual([w.manager.membershipId])
    // Another till of the same outlet still has none.
    const reg = await registerDevice(db, w.owner, { outletId: w.ktl, name: 'Second' })
    const auth = await authenticateDevice(db, reg.token)
    if (!auth.ok) throw new Error()
    r = await sync(db, auth.device, { ops: [], hashes: {}, clock: CLOCK })
    expect(r.sections.staff!.data.staff.every((s) => s.pin === null)).toBe(true)
  })

  it('drops people deactivated or moved to another outlet from the staff section', async () => {
    const w = await tillWorld()
    await deactivateStaff(db, w.owner, w.cashier.membershipId)
    await updateStaff(db, w.owner, w.manager.membershipId, { outletIds: [w.eld] })
    const r = await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })
    expect(r.sections.staff!.data.staff.map((s) => s.role)).toEqual(['owner'])
  })

  it('refuses a malformed request', async () => {
    const w = await tillWorld()
    await expect(sync(db, w.device, { ops: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
