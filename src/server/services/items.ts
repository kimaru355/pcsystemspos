import { and, asc, eq, exists, ilike, ne, or, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import {
  brands,
  categories,
  itemBarcodes,
  itemGroups,
  itemPacks,
  items,
  stockMovements,
} from '@/db/schema'
import { isUuid } from '@/domain/ids'
import type { Cents, Milli } from '@/domain/money'
import { isWholeUnits } from '@/domain/stock'
import { DEFAULT_TAX_CATEGORY, isTaxCategory, vatRateBp, type TaxCategory } from '@/domain/tax'
import { uniqueViolationConstraint } from '@/server/db-errors'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'
import { normalizeAttributeKey } from './taxonomy'

/*
 * Items, packs and barcodes.
 *
 * Reusable by the CSV import (Task 6), all inside a caller-owned transaction:
 *  - validateItemInput(i) / validatePackInput(i, fractional) / normalizeBarcode(raw)   (pure, no DB)
 *  - insertItemTx(tx, ctx, validItem)                      references + SKU check, insert, audit `item.create`
 *  - insertPackTx(tx, ctx, itemId, validPack)              name check, insert, audit `pack.create`
 *  - insertBarcodeTx(tx, ctx, itemId, {barcode, packId})   pack/duplicate check, insert, audit `barcode.add`
 * The public functions below validate first, then call these inside one transaction.
 * A unique violation that races past a service check is mapped to `conflict` by `mapRace`.
 */

export type Pack = {
  id: string
  name: string
  baseQtyMilli: Milli
  priceCents: Cents
  floorCents: Cents
  active: boolean
}

export type Barcode = { id: string; barcode: string; packId: string | null }

export type ItemInput = {
  name: string
  groupId?: string | null
  categoryId?: string | null
  brandId?: string | null
  attributes?: Record<string, string>
  sku?: string | null
  baseUnit: string
  fractional: boolean
  priceCents: Cents
  floorCents: Cents
  taxCategory?: TaxCategory
  lowStockMilli: Milli | null
}

export type Item = Required<Omit<ItemInput, 'taxCategory'>> & {
  id: string
  taxCategory: TaxCategory
  vatRateBp: number
  active: boolean
  packs: Pack[]
  barcodes: Barcode[]
}

export type ItemListRow = Omit<Item, 'packs' | 'barcodes'> & {
  /** Active packs only. */
  packCount: number
  categoryName: string | null
}

/** An item input after validation and normalization. */
export type ValidItem = Required<Omit<ItemInput, 'taxCategory'>> & { taxCategory: TaxCategory }

export type PackInput = { name: string; baseQtyMilli: Milli; priceCents: Cents; floorCents: Cents }
export type ValidPack = PackInput

const INT4_MAX = 2147483647
const MAX_ATTRIBUTES = 5
const BARCODE_RE = /^[0-9A-Za-z.\-]{1,64}$/

// ---------------------------------------------------------------- validators

function parseText(v: unknown, label: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < 1 || s.length > max) {
    throw new DomainError('invalid_input', `${label} must be 1 to ${max} characters.`)
  }
  return s
}

function parseCents(v: unknown, label: string): Cents {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > INT4_MAX) {
    throw new DomainError('invalid_input', `${label} must be a whole number of cents, 0 or more.`)
  }
  return v
}

function parsePrices(priceCents: unknown, floorCents: unknown): { priceCents: Cents; floorCents: Cents } {
  const price = parseCents(priceCents, 'Price')
  const floor = parseCents(floorCents, 'Lowest price')
  if (floor > price) throw new DomainError('invalid_input', "The lowest price can't be above the price.")
  return { priceCents: price, floorCents: floor }
}

function parseOptionalRef(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new DomainError('not_found')
  return v
}

function parseSku(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new DomainError('invalid_input', 'SKU must be text.')
  const s = v.trim()
  if (s === '') return null
  if (s.length > 64) throw new DomainError('invalid_input', 'SKU must be at most 64 characters.')
  return s
}

/** Keys are trimmed and lower-cased; values are trimmed (1-50 chars); empty values are dropped. At most 5. */
function parseAttributes(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new DomainError('invalid_input', 'Attributes must be a set of name and value pairs.')
  }
  const out: Record<string, string> = {}
  for (const [rawKey, rawVal] of Object.entries(v)) {
    if (typeof rawVal !== 'string') throw new DomainError('invalid_input', 'Attribute values must be text.')
    const value = rawVal.trim()
    if (value === '') continue
    if (value.length > 50) {
      throw new DomainError('invalid_input', 'Attribute values must be at most 50 characters.')
    }
    const key = normalizeAttributeKey(rawKey)
    if (key in out) throw new DomainError('invalid_input', 'Attribute names must be different from each other.')
    out[key] = value
  }
  if (Object.keys(out).length > MAX_ATTRIBUTES) {
    throw new DomainError('invalid_input', `An item can have at most ${MAX_ATTRIBUTES} attributes.`)
  }
  return out
}

/** Pure validation and normalization of an item. Database-dependent rules live in the `*Tx` inserts. */
export function validateItemInput(i: ItemInput): ValidItem {
  if (typeof i.fractional !== 'boolean') {
    throw new DomainError('invalid_input', 'Say whether the item is sold in fractions.')
  }
  let taxCategory = DEFAULT_TAX_CATEGORY
  if (i.taxCategory !== undefined) {
    if (!isTaxCategory(i.taxCategory)) throw new DomainError('invalid_input', 'Choose a valid tax category.')
    taxCategory = i.taxCategory
  }
  let lowStockMilli: Milli | null = null
  if (i.lowStockMilli !== undefined && i.lowStockMilli !== null) {
    if (typeof i.lowStockMilli !== 'number' || !Number.isSafeInteger(i.lowStockMilli) || i.lowStockMilli < 0) {
      throw new DomainError('invalid_input', 'The low stock level must be 0 or more.')
    }
    if (!i.fractional && !isWholeUnits(i.lowStockMilli)) {
      throw new DomainError('invalid_input', 'The low stock level must be a whole number for this item.')
    }
    lowStockMilli = i.lowStockMilli
  }
  return {
    name: parseText(i.name, 'Name', 200),
    groupId: parseOptionalRef(i.groupId),
    categoryId: parseOptionalRef(i.categoryId),
    brandId: parseOptionalRef(i.brandId),
    attributes: parseAttributes(i.attributes),
    sku: parseSku(i.sku),
    baseUnit: parseText(i.baseUnit, 'Unit', 20).toLowerCase(),
    fractional: i.fractional,
    ...parsePrices(i.priceCents, i.floorCents),
    taxCategory,
    lowStockMilli,
  }
}

/** Pure validation of a pack; `fractional` is the owning item's setting. */
export function validatePackInput(i: PackInput, fractional: boolean): ValidPack {
  const q = i.baseQtyMilli
  if (typeof q !== 'number' || !Number.isSafeInteger(q) || q <= 0) {
    throw new DomainError('invalid_input', 'A pack must hold more than 0 units.')
  }
  if (!fractional && !isWholeUnits(q)) {
    throw new DomainError('invalid_input', 'A pack of this item must hold a whole number of units.')
  }
  return {
    name: parseText(i.name, 'Pack name', 40),
    baseQtyMilli: q,
    ...parsePrices(i.priceCents, i.floorCents),
  }
}

/** Trim and check a barcode; `invalid_input` unless it is 1-64 of letters, digits, `.` or `-`. */
export function normalizeBarcode(raw: string): string {
  const b = typeof raw === 'string' ? raw.trim() : ''
  if (!BARCODE_RE.test(b)) {
    throw new DomainError('invalid_input', 'A barcode is 1 to 64 letters, digits, dots or dashes.')
  }
  return b
}

// -------------------------------------------------------------------- mapping

type ItemRow = typeof items.$inferSelect

function toPack(r: typeof itemPacks.$inferSelect): Pack {
  return {
    id: r.id,
    name: r.name,
    baseQtyMilli: r.baseQtyMilli,
    priceCents: r.priceCents,
    floorCents: r.floorCents,
    active: r.active,
  }
}

function toBarcode(r: typeof itemBarcodes.$inferSelect): Barcode {
  return { id: r.id, barcode: r.barcode, packId: r.packId }
}

function toItemBase(r: ItemRow): Omit<Item, 'packs' | 'barcodes'> {
  return {
    id: r.id,
    name: r.name,
    groupId: r.groupId,
    categoryId: r.categoryId,
    brandId: r.brandId,
    attributes: (r.attributes ?? {}) as Record<string, string>,
    sku: r.sku,
    baseUnit: r.baseUnit,
    fractional: r.fractional,
    priceCents: r.priceCents,
    floorCents: r.floorCents,
    taxCategory: r.taxCategory,
    vatRateBp: vatRateBp(r.taxCategory),
    lowStockMilli: r.lowStockMilli,
    active: r.active,
  }
}

/** The audited, editable shape of an item (no id). */
function snapshot(r: ItemRow) {
  const base = toItemBase(r)
  return {
    name: base.name,
    groupId: base.groupId,
    categoryId: base.categoryId,
    brandId: base.brandId,
    attributes: base.attributes,
    sku: base.sku,
    baseUnit: base.baseUnit,
    fractional: base.fractional,
    priceCents: base.priceCents,
    floorCents: base.floorCents,
    taxCategory: base.taxCategory,
    lowStockMilli: base.lowStockMilli,
    active: base.active,
  }
}

async function loadItem(db: Db | Tx, businessId: string, id: string): Promise<Item | undefined> {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.businessId, businessId)))
  if (!row) return undefined
  const [packs, barcodes] = await Promise.all([
    db
      .select()
      .from(itemPacks)
      .where(and(eq(itemPacks.itemId, id), eq(itemPacks.businessId, businessId)))
      .orderBy(asc(itemPacks.baseQtyMilli), asc(itemPacks.name)),
    db
      .select()
      .from(itemBarcodes)
      .where(and(eq(itemBarcodes.itemId, id), eq(itemBarcodes.businessId, businessId)))
      .orderBy(asc(itemBarcodes.createdAt), asc(itemBarcodes.barcode)),
  ])
  return { ...toItemBase(row), packs: packs.map(toPack), barcodes: barcodes.map(toBarcode) }
}

const SKU_TAKEN = 'That SKU is already used.'
const BARCODE_TAKEN = 'That barcode is already used.'
const PACK_NAME_TAKEN = 'This item already has a pack with that name.'

/** Run a write; a unique violation that raced past the service checks becomes `conflict`. */
async function mapRace<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    switch (uniqueViolationConstraint(e)) {
      case 'items_business_sku_unique':
        throw new DomainError('conflict', SKU_TAKEN)
      case 'item_barcodes_business_barcode_unique':
        throw new DomainError('conflict', BARCODE_TAKEN)
      case 'item_packs_item_name_unique':
        throw new DomainError('conflict', PACK_NAME_TAKEN)
      case undefined:
        throw e
      default:
        throw new DomainError('conflict')
    }
  }
}

// --------------------------------------------------------- reference checks

/**
 * Group, category and brand must belong to the business (`not_found`). With a group, every
 * attribute key must be one of the group's keys (`invalid_input`) unless `checkAttributes` is false.
 */
async function assertRefsTx(
  tx: Tx,
  ctx: TenantCtx,
  v: Pick<ValidItem, 'groupId' | 'categoryId' | 'brandId' | 'attributes'>,
  checkAttributes = true,
): Promise<void> {
  if (v.categoryId !== null) {
    if (!isUuid(v.categoryId)) throw new DomainError('not_found')
    const [c] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, v.categoryId), eq(categories.businessId, ctx.businessId)))
    if (!c) throw new DomainError('not_found')
  }
  if (v.brandId !== null) {
    if (!isUuid(v.brandId)) throw new DomainError('not_found')
    const [b] = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, v.brandId), eq(brands.businessId, ctx.businessId)))
    if (!b) throw new DomainError('not_found')
  }
  if (v.groupId !== null) {
    if (!isUuid(v.groupId)) throw new DomainError('not_found')
    const [g] = await tx
      .select({ attributeKeys: itemGroups.attributeKeys })
      .from(itemGroups)
      .where(and(eq(itemGroups.id, v.groupId), eq(itemGroups.businessId, ctx.businessId)))
    if (!g) throw new DomainError('not_found')
    if (checkAttributes) {
      const allowed = new Set(g.attributeKeys)
      for (const key of Object.keys(v.attributes)) {
        if (!allowed.has(key)) {
          throw new DomainError('invalid_input', `"${key}" is not an attribute of this item's group.`)
        }
      }
    }
  }
}

async function skuTakenTx(tx: Tx, ctx: TenantCtx, sku: string, excludeId?: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: items.id })
    .from(items)
    .where(
      and(
        eq(items.businessId, ctx.businessId),
        sql`lower(${items.sku}) = lower(${sku})`,
        excludeId ? ne(items.id, excludeId) : undefined,
      ),
    )
    .limit(1)
  return !!row
}

// ------------------------------------------------------------------- inserts

/** Insert a validated item (reference and SKU checks, audit `item.create`). Call inside a transaction. */
export async function insertItemTx(tx: Tx, ctx: TenantCtx, v: ValidItem): Promise<Item> {
  await assertRefsTx(tx, ctx, v)
  if (v.sku !== null && (await skuTakenTx(tx, ctx, v.sku))) throw new DomainError('conflict', SKU_TAKEN)
  const [row] = await tx
    .insert(items)
    .values({ businessId: ctx.businessId, ...v })
    .returning()
  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'item.create',
    entityType: 'item',
    entityId: row.id,
    data: v,
  })
  return { ...toItemBase(row), packs: [], barcodes: [] }
}

/** Insert a validated pack for an item of this business (name check, audit `pack.create`). */
export async function insertPackTx(
  tx: Tx,
  ctx: TenantCtx,
  itemId: string,
  v: ValidPack,
): Promise<Pack> {
  const [dup] = await tx
    .select({ id: itemPacks.id })
    .from(itemPacks)
    .where(and(eq(itemPacks.itemId, itemId), sql`lower(${itemPacks.name}) = lower(${v.name})`))
    .limit(1)
  if (dup) throw new DomainError('conflict', PACK_NAME_TAKEN)
  const [row] = await tx
    .insert(itemPacks)
    .values({ businessId: ctx.businessId, itemId, ...v })
    .returning()
  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'pack.create',
    entityType: 'item_pack',
    entityId: row.id,
    data: { itemId, ...v },
  })
  return toPack(row)
}

/** Insert a normalized barcode for an item of this business (pack and duplicate checks, audit `barcode.add`). */
export async function insertBarcodeTx(
  tx: Tx,
  ctx: TenantCtx,
  itemId: string,
  v: { barcode: string; packId: string | null },
): Promise<Barcode> {
  if (v.packId !== null) {
    if (!isUuid(v.packId)) throw new DomainError('not_found')
    const [p] = await tx
      .select({ id: itemPacks.id })
      .from(itemPacks)
      .where(
        and(
          eq(itemPacks.id, v.packId),
          eq(itemPacks.itemId, itemId),
          eq(itemPacks.businessId, ctx.businessId),
        ),
      )
    if (!p) throw new DomainError('not_found')
  }
  const [dup] = await tx
    .select({ id: itemBarcodes.id })
    .from(itemBarcodes)
    .where(and(eq(itemBarcodes.businessId, ctx.businessId), eq(itemBarcodes.barcode, v.barcode)))
    .limit(1)
  if (dup) throw new DomainError('conflict', BARCODE_TAKEN)
  const [row] = await tx
    .insert(itemBarcodes)
    .values({ businessId: ctx.businessId, itemId, barcode: v.barcode, packId: v.packId })
    .returning()
  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'barcode.add',
    entityType: 'item_barcode',
    entityId: row.id,
    data: { itemId, barcode: v.barcode, packId: v.packId },
  })
  return toBarcode(row)
}

// ------------------------------------------------------------------- queries

/** Escape `%`, `_` and `\` so user text is matched literally by ILIKE. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Items of the business ordered by name. `search` matches the name (ILIKE, literal), the SKU
 * (case-insensitive, exact) or any barcode (exact). A top-level `categoryId` also covers its children.
 */
export async function listItems(
  db: Db,
  ctx: TenantCtx,
  q: { search?: string; categoryId?: string; active?: boolean } = {},
): Promise<ItemListRow[]> {
  const conditions = [eq(items.businessId, ctx.businessId)]

  const term = q.search?.trim()
  if (term) {
    conditions.push(
      or(
        ilike(items.name, `%${escapeLike(term)}%`),
        sql`lower(${items.sku}) = lower(${term})`,
        exists(
          db
            .select({ one: sql`1` })
            .from(itemBarcodes)
            .where(
              and(
                eq(itemBarcodes.itemId, items.id),
                eq(itemBarcodes.businessId, ctx.businessId),
                eq(itemBarcodes.barcode, term),
              ),
            ),
        ),
      )!,
    )
  }
  if (q.categoryId !== undefined) {
    if (!isUuid(q.categoryId)) return []
    conditions.push(
      sql`${items.categoryId} in (
        select ${categories.id} from ${categories}
        where ${categories.businessId} = ${ctx.businessId}
          and (${categories.id} = ${q.categoryId} or ${categories.parentId} = ${q.categoryId}))`,
    )
  }
  if (q.active !== undefined) conditions.push(eq(items.active, q.active))

  const rows = await db
    .select({
      item: items,
      categoryName: categories.name,
      packCount: sql<number>`(select count(*)::int from ${itemPacks}
        where ${itemPacks.itemId} = ${items.id} and ${itemPacks.active})`,
    })
    .from(items)
    .leftJoin(categories, eq(categories.id, items.categoryId))
    .where(and(...conditions))
    .orderBy(asc(items.name), asc(items.id))
  return rows.map((r) => ({
    ...toItemBase(r.item),
    packCount: r.packCount,
    categoryName: r.categoryName,
  }))
}

export async function getItem(db: Db, ctx: TenantCtx, id: string): Promise<Item> {
  if (!isUuid(id)) throw new DomainError('not_found')
  const item = await loadItem(db, ctx.businessId, id)
  if (!item) throw new DomainError('not_found')
  return item
}

/**
 * Resolve a scanned code to its item (and pack, for pack barcodes). `null` for an unknown
 * or malformed code and for an inactive item.
 */
export async function lookupBarcode(
  db: Db,
  ctx: TenantCtx,
  barcode: string,
): Promise<{ item: Item; pack: Pack | null } | null> {
  const code = typeof barcode === 'string' ? barcode.trim() : ''
  if (!BARCODE_RE.test(code)) return null
  const [hit] = await db
    .select({ itemId: itemBarcodes.itemId, packId: itemBarcodes.packId })
    .from(itemBarcodes)
    .innerJoin(items, eq(items.id, itemBarcodes.itemId))
    .where(
      and(
        eq(itemBarcodes.businessId, ctx.businessId),
        eq(itemBarcodes.barcode, code),
        eq(items.businessId, ctx.businessId),
        eq(items.active, true),
      ),
    )
  if (!hit) return null
  const item = await loadItem(db, ctx.businessId, hit.itemId)
  if (!item) return null
  const pack = hit.packId ? (item.packs.find((p) => p.id === hit.packId) ?? null) : null
  return { item, pack }
}

// -------------------------------------------------------------------- writes

export async function createItem(db: Db, ctx: TenantCtx, i: ItemInput): Promise<Item> {
  assertCan(ctx, 'catalog.manage')
  const v = validateItemInput(i)
  return mapRace(() => db.transaction((tx) => insertItemTx(tx, ctx, v)))
}

/**
 * Patch an item. Fields left `undefined` are unchanged; the merged result is validated as a
 * whole. Changing `baseUnit` or `fractional` is refused once the item has stock movements.
 */
export async function updateItem(
  db: Db,
  ctx: TenantCtx,
  id: string,
  patch: Partial<ItemInput & { active: boolean }>,
): Promise<Item> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(id)) throw new DomainError('not_found')

  return mapRace(() =>
    db.transaction(async (tx) => {
      const scope = and(eq(items.id, id), eq(items.businessId, ctx.businessId))
      const [existing] = await tx.select().from(items).where(scope).for('update')
      if (!existing) throw new DomainError('not_found')

      const base = toItemBase(existing)
      const v = validateItemInput({
        name: patch.name ?? base.name,
        groupId: patch.groupId !== undefined ? patch.groupId : base.groupId,
        categoryId: patch.categoryId !== undefined ? patch.categoryId : base.categoryId,
        brandId: patch.brandId !== undefined ? patch.brandId : base.brandId,
        attributes: patch.attributes !== undefined ? patch.attributes : base.attributes,
        sku: patch.sku !== undefined ? patch.sku : base.sku,
        baseUnit: patch.baseUnit ?? base.baseUnit,
        fractional: patch.fractional ?? base.fractional,
        priceCents: patch.priceCents ?? base.priceCents,
        floorCents: patch.floorCents ?? base.floorCents,
        taxCategory: patch.taxCategory ?? base.taxCategory,
        lowStockMilli: patch.lowStockMilli !== undefined ? patch.lowStockMilli : base.lowStockMilli,
      })
      const active = patch.active !== undefined ? patch.active === true : existing.active

      if (v.baseUnit !== existing.baseUnit || v.fractional !== existing.fractional) {
        const [moved] = await tx
          .select({ id: stockMovements.id })
          .from(stockMovements)
          .where(and(eq(stockMovements.itemId, id), eq(stockMovements.businessId, ctx.businessId)))
          .limit(1)
        if (moved) {
          throw new DomainError('conflict', "This item already has stock history; its unit can't change.")
        }
      }
      if (existing.fractional && !v.fractional) {
        const [fractionalPack] = await tx
          .select({ id: itemPacks.id })
          .from(itemPacks)
          .where(and(eq(itemPacks.itemId, id), sql`${itemPacks.baseQtyMilli} % 1000 <> 0`))
          .limit(1)
        if (fractionalPack) {
          throw new DomainError('invalid_input', 'A pack of this item holds a fraction of a unit.')
        }
      }

      await assertRefsTx(tx, ctx, v, patch.groupId !== undefined || patch.attributes !== undefined)
      if (v.sku !== null && v.sku !== existing.sku && (await skuTakenTx(tx, ctx, v.sku, id))) {
        throw new DomainError('conflict', SKU_TAKEN)
      }

      const [row] = await tx
        .update(items)
        .set({ ...v, active, updatedAt: new Date() })
        .where(scope)
        .returning()
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'item.update',
        entityType: 'item',
        entityId: id,
        data: { before: snapshot(existing), after: snapshot(row) },
      })
      return (await loadItem(tx, ctx.businessId, id))!
    }),
  )
}

export async function addPack(db: Db, ctx: TenantCtx, itemId: string, i: PackInput): Promise<Pack> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(itemId)) throw new DomainError('not_found')
  return mapRace(() =>
    db.transaction(async (tx) => {
      const [item] = await tx
        .select({ fractional: items.fractional })
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.businessId, ctx.businessId)))
        .for('share')
      if (!item) throw new DomainError('not_found')
      return insertPackTx(tx, ctx, itemId, validatePackInput(i, item.fractional))
    }),
  )
}

export async function updatePack(
  db: Db,
  ctx: TenantCtx,
  packId: string,
  patch: Partial<{
    name: string
    baseQtyMilli: Milli
    priceCents: Cents
    floorCents: Cents
    active: boolean
  }>,
): Promise<Pack> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(packId)) throw new DomainError('not_found')
  return mapRace(() =>
    db.transaction(async (tx) => {
      const scope = and(eq(itemPacks.id, packId), eq(itemPacks.businessId, ctx.businessId))
      const [existing] = await tx.select().from(itemPacks).where(scope).for('update')
      if (!existing) throw new DomainError('not_found')
      const [item] = await tx
        .select({ fractional: items.fractional })
        .from(items)
        .where(and(eq(items.id, existing.itemId), eq(items.businessId, ctx.businessId)))
      if (!item) throw new DomainError('not_found')

      const v = validatePackInput(
        {
          name: patch.name ?? existing.name,
          baseQtyMilli: patch.baseQtyMilli ?? existing.baseQtyMilli,
          priceCents: patch.priceCents ?? existing.priceCents,
          floorCents: patch.floorCents ?? existing.floorCents,
        },
        item.fractional,
      )
      const active = patch.active !== undefined ? patch.active === true : existing.active
      if (v.name !== existing.name) {
        const [dup] = await tx
          .select({ id: itemPacks.id })
          .from(itemPacks)
          .where(
            and(
              eq(itemPacks.itemId, existing.itemId),
              sql`lower(${itemPacks.name}) = lower(${v.name})`,
              ne(itemPacks.id, packId),
            ),
          )
          .limit(1)
        if (dup) throw new DomainError('conflict', PACK_NAME_TAKEN)
      }

      const [row] = await tx.update(itemPacks).set({ ...v, active }).where(scope).returning()
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'pack.update',
        entityType: 'item_pack',
        entityId: packId,
        data: { itemId: existing.itemId, before: toPack(existing), after: toPack(row) },
      })
      return toPack(row)
    }),
  )
}

export async function addBarcode(
  db: Db,
  ctx: TenantCtx,
  itemId: string,
  i: { barcode: string; packId: string | null },
): Promise<Barcode> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(itemId)) throw new DomainError('not_found')
  const barcode = normalizeBarcode(i.barcode)
  const packId = i.packId ?? null
  return mapRace(() =>
    db.transaction(async (tx) => {
      const [item] = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.id, itemId), eq(items.businessId, ctx.businessId)))
      if (!item) throw new DomainError('not_found')
      return insertBarcodeTx(tx, ctx, itemId, { barcode, packId })
    }),
  )
}

/** Barcode mappings are the one catalog row that is hard-deleted. */
export async function removeBarcode(db: Db, ctx: TenantCtx, barcodeId: string): Promise<void> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(barcodeId)) throw new DomainError('not_found')
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(itemBarcodes)
      .where(and(eq(itemBarcodes.id, barcodeId), eq(itemBarcodes.businessId, ctx.businessId)))
      .returning()
    if (!row) throw new DomainError('not_found')
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'barcode.remove',
      entityType: 'item_barcode',
      entityId: row.id,
      data: { itemId: row.itemId, barcode: row.barcode, packId: row.packId },
    })
  })
}
