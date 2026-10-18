import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './auth'
import { devices } from './devices'
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
    /** Set for actions taken on a till: the device, when it happened there, and the sync op. */
    deviceId: uuid('device_id').references(() => devices.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    opId: uuid('op_id'),
    /** Monotonic tie-breaker for rows written in the same instant (an import writes thousands). */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    // NULLS FIRST matches the feed's plain `desc` ordering, so the index serves it.
    index('audit_log_business_created_seq_idx').on(
      t.businessId,
      t.createdAt.desc().nullsFirst(),
      t.seq.desc().nullsFirst(),
    ),
  ],
)
