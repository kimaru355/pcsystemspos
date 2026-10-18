import {
  boolean,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { businesses, outlets } from './tenancy'

export const role = pgEnum('role', ['owner', 'manager', 'cashier'])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').unique(),
    phone: text('phone').unique(),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_email_or_phone', sql`${t.email} is not null or ${t.phone} is not null`),
    uniqueIndex('users_email_lower_unique').on(sql`lower(${t.email})`),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: role('role').notNull(),
    pinHash: text('pin_hash'),
    /** PBKDF2 verifier of the same PIN, checkable offline by the till (see src/domain/pin.ts). */
    pinSalt: text('pin_salt'),
    pinVerifier: text('pin_verifier'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memberships_business_id_idx').on(t.businessId),
    // A person is active in at most one business at a time; old memberships stay as history.
    uniqueIndex('memberships_active_user_unique').on(t.userId).where(sql`${t.active}`),
    index('memberships_user_id_idx').on(t.userId),
  ],
)

export const membershipOutlets = pgTable(
  'membership_outlets',
  {
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.outletId] }),
    index('membership_outlets_outlet_id_idx').on(t.outletId),
    foreignKey({
      name: 'membership_outlets_outlet_business_fk',
      columns: [t.outletId, t.businessId],
      foreignColumns: [outlets.id, outlets.businessId],
    }),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 hex of the session token */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
)

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    success: boolean('success').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_attempts_identifier_attempted_at_idx').on(t.identifier, t.attemptedAt)],
)
