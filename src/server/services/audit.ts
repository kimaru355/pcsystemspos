import type { Db, Tx } from '@/db/client'
import { auditLog } from '@/db/schema'

export type AuditEvent = {
  /** null = platform event */
  businessId: string | null
  actorUserId: string
  action: string
  entityType: string
  entityId: string
  reason?: string
  data?: unknown
}

/** Pass the surrounding transaction so the audit row commits or rolls back with the change. */
export async function recordAudit(tx: Tx | Db, e: AuditEvent): Promise<void> {
  await tx.insert(auditLog).values({
    businessId: e.businessId,
    actorUserId: e.actorUserId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    reason: e.reason ?? null,
    data: e.data ?? null,
  })
}
