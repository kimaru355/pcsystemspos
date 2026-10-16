import { boolean, pgEnum, pgTable, timestamp, unique, uuid, varchar, text } from 'drizzle-orm/pg-core'

export const connectionMode = pgEnum('connection_mode', ['full_offline', 'default', 'always_online'])
export const businessStatus = pgEnum('business_status', ['active', 'suspended'])

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: businessStatus('status').notNull().default('active'),
  defaultConnectionMode: connectionMode('default_connection_mode').notNull().default('default'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const outlets = pgTable(
  'outlets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    code: varchar('code', { length: 5 }).notNull(),
    /** null = use the business default */
    connectionMode: connectionMode('connection_mode'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('outlets_business_code_unique').on(t.businessId, t.code)],
)
