import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth'
import { businesses } from './tenancy'

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null = platform event */
    businessId: uuid('business_id').references(() => businesses.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    reason: text('reason'),
    data: jsonb('data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Monotonic tie-breaker for rows written in the same instant (an import writes thousands). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('audit_log_business_created_seq_idx').on(t.businessId, t.createdAt.desc(), t.seq.desc()),
  ],
)
