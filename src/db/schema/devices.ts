import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { memberships, users } from './auth'
import { businesses, outlets } from './tenancy'

/** A browser registered as a till of one outlet. It authenticates with its own token, not a user session. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id),
    /** Two digits, part of order numbers (KTL-03-000123). Never reused within the outlet. */
    code: varchar('code', { length: 2 }).notNull(),
    name: text('name').notNull(),
    /** sha256 hex of the device token */
    tokenHash: text('token_hash').notNull().unique(),
    registeredBy: uuid('registered_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    /** Highest order sequence the server has seen from this device. */
    lastOrderSeq: integer('last_order_seq').notNull().default(0),
    clockJumps: integer('clock_jumps').notNull().default(0),
    lastClockJumpAt: timestamp('last_clock_jump_at', { withTimezone: true }),
  },
  (t) => [
    unique('devices_outlet_code_unique').on(t.outletId, t.code),
    check('devices_code_format', sql`${t.code} ~ '^[0-9]{2}$'`),
    foreignKey({
      name: 'devices_outlet_business_fk',
      columns: [t.outletId, t.businessId],
      foreignColumns: [outlets.id, outlets.businessId],
    }),
    index('devices_business_id_idx').on(t.businessId),
  ],
)

export const syncOpStatus = pgEnum('sync_op_status', ['applied', 'rejected'])

/**
 * Every operation a till has pushed, keyed by its client id: the exactly-once guard.
 * Rejected operations keep their payload so nothing a till recorded is ever lost.
 */
export const syncOps = pgTable(
  'sync_ops',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    type: text('type').notNull(),
    actorMembershipId: uuid('actor_membership_id').references(() => memberships.id),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    status: syncOpStatus('status').notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('sync_ops_business_device_received_idx').on(t.businessId, t.deviceId, t.receivedAt),
    index('sync_ops_business_rejected_idx')
      .on(t.businessId, t.receivedAt)
      .where(sql`${t.status} = 'rejected'`),
  ],
)

/** People who signed in on a till: only they get their PIN verifier on that device. */
export const deviceStaff = pgTable(
  'device_staff',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.membershipId] }), index('device_staff_membership_idx').on(t.membershipId)],
)
