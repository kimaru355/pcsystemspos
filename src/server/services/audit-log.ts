import { and, desc, eq, gte, like, lt, or, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { auditLog, devices, memberships, outlets, syncOps, users } from '@/db/schema'
import { assertCan, type TenantCtx } from '@/server/tenant'
import type { ActivityEntry } from './activity'

/* The owner's audit log viewer: every audited action, and operations the server refused from tills. */

export const AUDIT_GROUPS = {
  orders: ['order.', 'receipt.'],
  payments: ['mpesa.', 'order.mark_paid', 'order.refund'],
  stock: ['stock.'],
  staff: ['staff.'],
  tills: ['device.'],
  catalog: ['item.', 'pack.', 'barcode.', 'category.', 'brand.', 'group.', 'catalog.'],
  settings: ['outlet.', 'business.'],
} as const

export type AuditGroup = keyof typeof AUDIT_GROUPS

export type AuditRow = ActivityEntry & { seq: number; tillCode: string | null; occurredAt: Date | null }

export async function listAudit(
  db: Db,
  ctx: TenantCtx,
  f: { group?: AuditGroup; from?: Date; to?: Date; beforeSeq?: number; limit?: number } = {},
): Promise<AuditRow[]> {
  assertCan(ctx, 'audit.view')
  const prefixes = f.group ? AUDIT_GROUPS[f.group] : null
  const rows = await db
    .select({
      id: auditLog.id,
      seq: auditLog.seq,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      data: auditLog.data,
      reason: auditLog.reason,
      actorName: users.name,
      at: auditLog.createdAt,
      occurredAt: auditLog.occurredAt,
      tillCode: sql<string | null>`case when ${devices.id} is null then null else ${outlets.code} || '-' || ${devices.code} end`,
    })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(devices, eq(devices.id, auditLog.deviceId))
    .leftJoin(outlets, eq(outlets.id, devices.outletId))
    .where(
      and(
        eq(auditLog.businessId, ctx.businessId),
        prefixes ? or(...prefixes.map((p) => (p.endsWith('.') ? like(auditLog.action, `${p}%`) : eq(auditLog.action, p)))) : undefined,
        f.from ? gte(auditLog.createdAt, f.from) : undefined,
        f.to ? lt(auditLog.createdAt, f.to) : undefined,
        f.beforeSeq ? lt(auditLog.seq, f.beforeSeq) : undefined,
      ),
    )
    .orderBy(desc(auditLog.seq))
    .limit(Math.min(Math.max(f.limit ?? 100, 1), 200))
  return rows
}

export type RejectedOp = {
  id: string
  type: string
  tillCode: string
  actorName: string | null
  errorMessage: string | null
  receivedAt: Date
  payload: unknown
}

/** Operations a till recorded that the server refused (payload kept), newest first. */
export async function listRejectedOps(db: Db, ctx: TenantCtx, limit = 50): Promise<RejectedOp[]> {
  assertCan(ctx, 'audit.view')
  const rows = await db
    .select({
      id: syncOps.id,
      type: syncOps.type,
      outletCode: outlets.code,
      deviceCode: devices.code,
      actorName: users.name,
      errorMessage: syncOps.errorMessage,
      receivedAt: syncOps.receivedAt,
      payload: syncOps.payload,
    })
    .from(syncOps)
    .innerJoin(devices, eq(devices.id, syncOps.deviceId))
    .innerJoin(outlets, eq(outlets.id, devices.outletId))
    .leftJoin(memberships, eq(memberships.id, syncOps.actorMembershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(syncOps.businessId, ctx.businessId), eq(syncOps.status, 'rejected')))
    .orderBy(desc(syncOps.receivedAt))
    .limit(limit)
  return rows.map((r) => ({ ...r, tillCode: `${r.outletCode}-${r.deviceCode}` }))
}
