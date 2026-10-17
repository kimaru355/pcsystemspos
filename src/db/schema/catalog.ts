import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { businesses } from './tenancy'

export const taxCategory = pgEnum('tax_category', ['A', 'B', 'C', 'D', 'E'])

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'categories_parent_id_categories_id_fk',
      columns: [t.parentId],
      foreignColumns: [t.id],
    }),
    // nulls not distinct: two top-level categories may not share a name
    unique('categories_business_parent_name_unique')
      .on(t.businessId, t.parentId, t.name)
      .nullsNotDistinct(),
  ],
)

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('brands_business_name_unique').on(t.businessId, t.name)],
)

export const itemGroups = pgTable(
  'item_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    name: text('name').notNull(),
    categoryId: uuid('category_id').references(() => categories.id),
    brandId: uuid('brand_id').references(() => brands.id),
    attributeKeys: text('attribute_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('item_groups_business_name_unique').on(t.businessId, t.name)],
)

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    groupId: uuid('group_id').references(() => itemGroups.id),
    categoryId: uuid('category_id').references(() => categories.id),
    brandId: uuid('brand_id').references(() => brands.id),
    name: text('name').notNull(),
    attributes: jsonb('attributes')
      .notNull()
      .default(sql`'{}'::jsonb`),
    sku: text('sku'),
    baseUnit: text('base_unit').notNull(),
    fractional: boolean('fractional').notNull().default(false),
    priceCents: integer('price_cents').notNull(),
    floorCents: integer('floor_cents').notNull(),
    taxCategory: taxCategory('tax_category').notNull().default('B'),
    /** null = no low-stock alert */
    lowStockMilli: bigint('low_stock_milli', { mode: 'number' }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('items_business_sku_unique')
      .on(t.businessId, t.sku)
      .where(sql`${t.sku} is not null`),
    check('items_floor_le_price', sql`${t.floorCents} >= 0 and ${t.floorCents} <= ${t.priceCents}`),
  ],
)

export const itemPacks = pgTable(
  'item_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    name: text('name').notNull(),
    baseQtyMilli: bigint('base_qty_milli', { mode: 'number' }).notNull(),
    priceCents: integer('price_cents').notNull(),
    floorCents: integer('floor_cents').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('item_packs_item_name_unique').on(t.itemId, t.name),
    // target of the composite FK from item_barcodes (pack must belong to the item)
    unique('item_packs_id_item_unique').on(t.id, t.itemId),
    check('item_packs_base_qty_positive', sql`${t.baseQtyMilli} > 0`),
    check('item_packs_floor_le_price', sql`${t.floorCents} >= 0 and ${t.floorCents} <= ${t.priceCents}`),
  ],
)

export const itemBarcodes = pgTable(
  'item_barcodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    barcode: text('barcode').notNull(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id),
    packId: uuid('pack_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('item_barcodes_business_barcode_unique').on(t.businessId, t.barcode),
    foreignKey({
      name: 'item_barcodes_pack_item_fk',
      columns: [t.packId, t.itemId],
      foreignColumns: [itemPacks.id, itemPacks.itemId],
    }),
  ],
)
