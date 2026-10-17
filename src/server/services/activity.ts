import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { auditLog, users } from '@/db/schema'
import { can } from '@/domain/permissions'
import type { TenantCtx } from '@/server/tenant'

export type ActivityEntry = {
  id: string
  action: string
  entityType: string
  entityId: string
  data: unknown
  reason: string | null
  actorName: string
  at: Date
}

/**
 * The business's latest audited events. Owners see everything; anyone else only events
 * about the outlets and staff they can already see (pass those ids in `visible`).
 */
export async function listRecentActivity(
  db: Db,
  ctx: TenantCtx,
  visible: { outletIds: string[]; membershipIds: string[] },
  limit = 12,
): Promise<ActivityEntry[]> {
  const owner = can(ctx.role, 'business.settings')
  if (!owner && visible.outletIds.length === 0 && visible.membershipIds.length === 0) return []
  // An import stamps `importId` on its per-entity rows; the feed shows only its `catalog.import` summary.
  const notImportDetail = or(eq(auditLog.action, 'catalog.import'), sql`${auditLog.data} ->> 'importId' is null`)
  const scope = owner
    ? and(eq(auditLog.businessId, ctx.businessId), notImportDetail)
    : and(
        eq(auditLog.businessId, ctx.businessId),
        or(
          visible.outletIds.length
            ? and(eq(auditLog.entityType, 'outlet'), inArray(auditLog.entityId, visible.outletIds))
            : undefined,
          visible.membershipIds.length
            ? and(eq(auditLog.entityType, 'membership'), inArray(auditLog.entityId, visible.membershipIds))
            : undefined,
        ),
      )
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      data: auditLog.data,
      reason: auditLog.reason,
      actorName: users.name,
      at: auditLog.createdAt,
    })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.actorUserId))
    .where(scope)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.seq))
    .limit(Math.min(Math.max(limit, 1), 50))
}
