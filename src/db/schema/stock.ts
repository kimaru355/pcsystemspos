import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { items } from './catalog'
import { businesses, outlets } from './tenancy'

export const movementKind = pgEnum('movement_kind', ['receive', 'adjust', 'collect'])
export const adjustReason = pgEnum('adjust_reason', [
  'damaged',
  'count_correction',
  'lost_stolen',
  'other',
])

/** Append-only stock ledger. `outlet_stock` is the cached sum of `qty_milli`. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    kind: movementKind('kind').notNull(),
    qtyMilli: bigint('qty_milli', { mode: 'number' }).notNull(),
    unitCostCents: integer('unit_cost_cents'),
    reason: adjustReason('reason'),
    note: text('note'),
    orderLineId: uuid('order_line_id'),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('stock_movements_qty_nonzero', sql`${t.qtyMilli} <> 0`),
    check('stock_movements_receive_positive', sql`${t.kind} <> 'receive' or ${t.qtyMilli} > 0`),
    check('stock_movements_collect_negative', sql`${t.kind} <> 'collect' or ${t.qtyMilli} < 0`),
    check('stock_movements_adjust_reason', sql`${t.kind} <> 'adjust' or ${t.reason} is not null`),
    check('stock_movements_other_note', sql`${t.reason} <> 'other' or ${t.note} is not null`),
    check('stock_movements_unit_cost_nonneg', sql`${t.unitCostCents} is null or ${t.unitCostCents} >= 0`),
    index('stock_movements_business_item_idx').on(t.businessId, t.itemId),
    index('stock_movements_business_outlet_item_occurred_idx').on(
      t.businessId,
      t.outletId,
      t.itemId,
      t.occurredAt,
    ),
  ],
)

export const outletStock = pgTable(
  'outlet_stock',
  {
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    onHandMilli: bigint('on_hand_milli', { mode: 'number' }).notNull().default(0),
    flaggedNegativeAt: timestamp('flagged_negative_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.outletId, t.itemId] })],
)
