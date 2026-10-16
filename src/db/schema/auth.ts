import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
  (t) => [check('users_email_or_phone', sql`${t.email} is not null or ${t.phone} is not null`)],
)

export const memberships = pgTable('memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  // unique: a user belongs to at most one business in the MVP
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  role: role('role').notNull(),
  pinHash: text('pin_hash'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

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
  (t) => [primaryKey({ columns: [t.membershipId, t.outletId] })],
)

export const sessions = pgTable('sessions', {
  /** sha256 hex of the session token */
  id: text('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

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
