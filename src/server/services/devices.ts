import { createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { businesses, devices, outlets, users } from '@/db/schema'
import { isPastReminder, type ConnectionMode } from '@/domain/connection-modes'
import { isUuid } from '@/domain/ids'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'

/*
 * Till devices. A device authenticates with its own random token (sent as a Bearer header),
 * separate from user sessions: a password change or a web sign-out never logs a till out.
 */

const NAME_MAX = 60
const MAX_DEVICES_PER_OUTLET = 99

export type DeviceAuth = {
  deviceId: string
  businessId: string
  businessName: string
  outletId: string
  outletCode: string
  outletName: string
  outletActive: boolean
  code: string
  name: string
  mode: ConnectionMode
  lastOrderSeq: number
}

export type DeviceRow = {
  id: string
  outletId: string
  outletCode: string
  outletName: string
  code: string
  name: string
  registeredByName: string
  createdAt: Date
  revokedAt: Date | null
  lastSyncAt: Date | null
  clockJumps: number
  lastClockJumpAt: Date | null
  mode: ConnectionMode
  /** Not synced for longer than the outlet's reminder point (never for revoked devices). */
  pastReminder: boolean
}

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function parseName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s === '') throw new DomainError('invalid_input', 'Give the till a name, for example "Front counter".')
  if (s.length > NAME_MAX) throw new DomainError('invalid_input', `The name must be at most ${NAME_MAX} characters.`)
  return s
}

/** The outlet must be in the business (`not_found`), in scope (`forbidden`) and active. */
async function assertOutletForDevices(tx: Tx | Db, ctx: TenantCtx, outletId: string) {
  if (!isUuid(outletId)) throw new DomainError('not_found')
  const [o] = await tx
    .select({ id: outlets.id, code: outlets.code, active: outlets.active })
    .from(outlets)
    .where(and(eq(outlets.id, outletId), eq(outlets.businessId, ctx.businessId)))
  if (!o) throw new DomainError('not_found')
  if (ctx.outletScope !== 'all' && !ctx.outletScope.includes(o.id)) throw new DomainError('forbidden')
  return o
}

/** Registers a browser as a till of an outlet. The token is returned once and never stored. */
export async function registerDevice(
  db: Db,
  ctx: TenantCtx,
  i: { outletId: string; name: string },
): Promise<{ token: string; deviceId: string; code: string }> {
  assertCan(ctx, 'device.manage')
  const name = parseName(i.name)
  const token = randomBytes(32).toString('base64url')
  return db.transaction(async (tx) => {
    const outlet = await assertOutletForDevices(tx, ctx, i.outletId)
    if (!outlet.active) throw new DomainError('invalid_input', 'That outlet is inactive.')
    // Serialise code allocation per outlet.
    await tx.select({ id: outlets.id }).from(outlets).where(eq(outlets.id, outlet.id)).for('update')
    const [{ maxCode }] = await tx
      .select({ maxCode: sql<number>`coalesce(max(${devices.code}::int), 0)::int` })
      .from(devices)
      .where(eq(devices.outletId, outlet.id))
    const next = maxCode + 1
    if (next > MAX_DEVICES_PER_OUTLET) {
      throw new DomainError('conflict', 'This outlet has used all 99 till numbers.')
    }
    const code = String(next).padStart(2, '0')
    const [row] = await tx
      .insert(devices)
      .values({
        businessId: ctx.businessId,
        outletId: outlet.id,
        code,
        name,
        tokenHash: hashDeviceToken(token),
        registeredBy: ctx.userId,
      })
      .returning({ id: devices.id })
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'device.register',
      entityType: 'device',
      entityId: row.id,
      data: { outletId: outlet.id, outletCode: outlet.code, code, name },
    })
    return { token, deviceId: row.id, code }
  })
}

export async function revokeDevice(db: Db, ctx: TenantCtx, deviceId: string): Promise<void> {
  assertCan(ctx, 'device.manage')
  if (!isUuid(deviceId)) throw new DomainError('not_found')
  await db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.businessId, ctx.businessId)))
      .for('update')
    if (!d) throw new DomainError('not_found')
    await assertOutletForDevices(tx, ctx, d.outletId)
    if (d.revokedAt) throw new DomainError('conflict', 'That till is already revoked.')
    await tx.update(devices).set({ revokedAt: new Date(), revokedBy: ctx.userId }).where(eq(devices.id, d.id))
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'device.revoke',
      entityType: 'device',
      entityId: d.id,
      data: { outletId: d.outletId, code: d.code, name: d.name },
    })
  })
}

/** Devices of the outlets in scope, active first, then by outlet and till number. */
export async function listDevices(db: Db, ctx: TenantCtx, now = new Date()): Promise<DeviceRow[]> {
  assertCan(ctx, 'device.manage')
  if (ctx.outletScope !== 'all' && ctx.outletScope.length === 0) return []
  const rows = await db
    .select({
      d: devices,
      outletCode: outlets.code,
      outletName: outlets.name,
      registeredByName: users.name,
      mode: sql<ConnectionMode>`coalesce(${outlets.connectionMode}, ${businesses.defaultConnectionMode})`,
    })
    .from(devices)
    .innerJoin(outlets, eq(outlets.id, devices.outletId))
    .innerJoin(businesses, eq(businesses.id, devices.businessId))
    .innerJoin(users, eq(users.id, devices.registeredBy))
    .where(
      and(
        eq(devices.businessId, ctx.businessId),
        ctx.outletScope === 'all' ? undefined : inArray(devices.outletId, ctx.outletScope),
      ),
    )
    .orderBy(sql`${devices.revokedAt} is not null`, asc(outlets.code), asc(devices.code), desc(devices.createdAt))
  return rows.map((r) => ({
    id: r.d.id,
    outletId: r.d.outletId,
    outletCode: r.outletCode,
    outletName: r.outletName,
    code: r.d.code,
    name: r.d.name,
    registeredByName: r.registeredByName,
    createdAt: r.d.createdAt,
    revokedAt: r.d.revokedAt,
    lastSyncAt: r.d.lastSyncAt,
    clockJumps: r.d.clockJumps,
    lastClockJumpAt: r.d.lastClockJumpAt,
    mode: r.mode,
    pastReminder:
      r.d.revokedAt === null &&
      isPastReminder(r.mode, now.getTime() - (r.d.lastSyncAt ?? r.d.createdAt).getTime()),
  }))
}

export type DeviceAuthResult = { ok: true; device: DeviceAuth } | { ok: false; reason: 'unknown' | 'revoked' | 'suspended' }

/** Resolves a Bearer token to its device. */
export async function authenticateDevice(db: Db | Tx, token: string): Promise<DeviceAuthResult> {
  if (!token || token.length > 200) return { ok: false, reason: 'unknown' }
  const [r] = await db
    .select({
      d: devices,
      businessName: businesses.name,
      businessStatus: businesses.status,
      outletCode: outlets.code,
      outletName: outlets.name,
      outletActive: outlets.active,
      mode: sql<ConnectionMode>`coalesce(${outlets.connectionMode}, ${businesses.defaultConnectionMode})`,
    })
    .from(devices)
    .innerJoin(outlets, eq(outlets.id, devices.outletId))
    .innerJoin(businesses, eq(businesses.id, devices.businessId))
    .where(eq(devices.tokenHash, hashDeviceToken(token)))
  if (!r) return { ok: false, reason: 'unknown' }
  if (r.d.revokedAt) return { ok: false, reason: 'revoked' }
  if (r.businessStatus !== 'active') return { ok: false, reason: 'suspended' }
  return {
    ok: true,
    device: {
      deviceId: r.d.id,
      businessId: r.d.businessId,
      businessName: r.businessName,
      outletId: r.d.outletId,
      outletCode: r.outletCode,
      outletName: r.outletName,
      outletActive: r.outletActive,
      code: r.d.code,
      name: r.d.name,
      mode: r.mode,
      lastOrderSeq: r.d.lastOrderSeq,
    },
  }
}
