import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { itemPacks, items, taxCategory } from './catalog'
import { devices } from './devices'
import { stockMovements } from './stock'
import { businesses, outlets } from './tenancy'

/*
 * Orders, payments and collections. Ids of orders, lines, payments and collections are
 * generated on the till. Order money columns are bigint: one order can pass int4's KES 21m.
 */

export const orderStatus = pgEnum('order_status', ['open', 'closed'])
export const paymentKind = pgEnum('payment_kind', ['payment', 'refund'])
export const paymentMethod = pgEnum('payment_method', ['cash', 'mark_paid', 'mpesa', 'other'])

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    /** E.164 */
    phone: text('phone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('customers_business_phone_unique').on(t.businessId, t.phone)],
)

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id),
    deviceId: uuid('device_id').references(() => devices.id),
    /** OUTLET-DEVICE-SEQ, e.g. KTL-03-000123 */
    number: text('number').notNull(),
    seq: integer('seq').notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    status: orderStatus('status').notNull().default('open'),
    /** Credit approved so far: goods may be handed over up to paid + credit. */
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    /** Set when collections synced from two tills went beyond paid + credit. */
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    unique('orders_business_number_unique').on(t.businessId, t.number),
    check('orders_seq_positive', sql`${t.seq} > 0`),
    check('orders_credit_nonneg', sql`${t.creditCents} >= 0`),
    check(
      'orders_customer_complete',
      sql`(${t.customerName} is null) = (${t.customerPhone} is null)`,
    ),
    foreignKey({
      name: 'orders_outlet_business_fk',
      columns: [t.outletId, t.businessId],
      foreignColumns: [outlets.id, outlets.businessId],
    }),
    index('orders_business_outlet_status_idx').on(t.businessId, t.outletId, t.status),
    index('orders_business_occurred_idx').on(t.businessId, t.occurredAt),
    index('orders_customer_id_idx').on(t.customerId),
  ],
)

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    /** null = sold in the item's base unit */
    packId: uuid('pack_id'),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    unitLabel: text('unit_label').notNull(),
    /** Base units in one sold unit (1000 for the base unit itself). */
    baseQtyPerUnitMilli: bigint('base_qty_per_unit_milli', { mode: 'number' }).notNull(),
    /** Quantities in the sold unit. */
    qtyMilli: bigint('qty_milli', { mode: 'number' }).notNull(),
    collectedMilli: bigint('collected_milli', { mode: 'number' }).notNull().default(0),
    cancelledMilli: bigint('cancelled_milli', { mode: 'number' }).notNull().default(0),
    unitPriceCents: integer('unit_price_cents').notNull(),
    listPriceCents: integer('list_price_cents').notNull(),
    floorCents: integer('floor_cents').notNull(),
    taxCategory: taxCategory('tax_category').notNull(),
    vatRateBp: integer('vat_rate_bp').notNull(),
    priceApprovedBy: uuid('price_approved_by').references(() => users.id),
  },
  (t) => [
    check('order_lines_qty_positive', sql`${t.qtyMilli} > 0`),
    check('order_lines_base_positive', sql`${t.baseQtyPerUnitMilli} > 0`),
    check(
      'order_lines_progress',
      sql`${t.collectedMilli} >= 0 and ${t.cancelledMilli} >= 0 and ${t.collectedMilli} + ${t.cancelledMilli} <= ${t.qtyMilli}`,
    ),
    check('order_lines_price_nonneg', sql`${t.unitPriceCents} >= 0`),
    foreignKey({
      name: 'order_lines_pack_item_fk',
      columns: [t.packId, t.itemId],
      foreignColumns: [itemPacks.id, itemPacks.itemId],
    }),
    foreignKey({
      name: 'order_lines_item_business_fk',
      columns: [t.itemId, t.businessId],
      foreignColumns: [items.id, items.businessId],
    }),
    unique('order_lines_order_position_unique').on(t.orderId, t.position),
    index('order_lines_business_item_idx').on(t.businessId, t.itemId),
  ],
)

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    kind: paymentKind('kind').notNull().default('payment'),
    method: paymentMethod('method').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    reason: text('reason'),
    approvedBy: uuid('approved_by').references(() => users.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').references(() => devices.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('payments_amount_positive', sql`${t.amountCents} > 0`),
    check(
      'payments_mark_paid_approved',
      sql`${t.method} <> 'mark_paid' or (${t.approvedBy} is not null and ${t.reason} is not null)`,
    ),
    check('payments_refund_reason', sql`${t.kind} <> 'refund' or ${t.reason} is not null`),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_business_occurred_idx').on(t.businessId, t.occurredAt),
  ],
)

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** Value of the goods handed over in this collection (VAT-inclusive). */
    valueCents: bigint('value_cents', { mode: 'number' }).notNull(),
    creditGrantedCents: bigint('credit_granted_cents', { mode: 'number' }).notNull().default(0),
    approvedBy: uuid('approved_by').references(() => users.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id),
    deviceId: uuid('device_id').references(() => devices.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('collections_value_nonneg', sql`${t.valueCents} >= 0`),
    check(
      'collections_credit_approved',
      sql`${t.creditGrantedCents} = 0 or ${t.approvedBy} is not null`,
    ),
    index('collections_order_id_idx').on(t.orderId),
  ],
)

export const collectionLines = pgTable(
  'collection_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id),
    /** In the sold unit. */
    qtyMilli: bigint('qty_milli', { mode: 'number' }).notNull(),
    /** In the item's base unit: what left the stock. */
    baseQtyMilli: bigint('base_qty_milli', { mode: 'number' }).notNull(),
    movementId: uuid('movement_id')
      .notNull()
      .unique()
      .references(() => stockMovements.id),
  },
  (t) => [
    check('collection_lines_qty_positive', sql`${t.qtyMilli} > 0 and ${t.baseQtyMilli} > 0`),
    unique('collection_lines_collection_line_unique').on(t.collectionId, t.orderLineId),
  ],
)
