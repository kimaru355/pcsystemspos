import { and, asc, eq, ne, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import { brands, categories, itemGroups } from '@/db/schema'
import { isUuid } from '@/domain/ids'
import { isUniqueViolation } from '@/server/db-errors'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'

/*
 * Taxonomy: categories (two levels), brands and item groups.
 *
 * Reusable by the CSV import (Task 6), all inside a caller-owned transaction:
 *  - validateCategoryInput / validateBrandInput / validateGroupInput  (pure, no DB)
 *  - insertCategoryTx / insertBrandTx / insertGroupTx                 (DB checks + insert + audit)
 *  - findOrCreateCategoryTx / findOrCreateBrandTx / findOrCreateGroupTx (case-insensitive match, else insert)
 *  - normalizeAttributeKey(s)                                         (shared with items.ts)
 * Names are matched case-insensitively in the service because the DB uniques are case-sensitive;
 * a race that slips past the check is still caught by those uniques and mapped to `conflict`.
 */

export type Category = {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
  active: boolean
}
export type Brand = { id: string; name: string; active: boolean }
export type ItemGroup = {
  id: string
  name: string
  categoryId: string | null
  brandId: string | null
  attributeKeys: string[]
  active: boolean
}

const ATTRIBUTE_KEY_RE = /^[a-z][a-z0-9_]{0,29}$/
const MAX_ATTRIBUTE_KEYS = 5
const INT4_MAX = 2147483647

function parseName(name: unknown, label: string): string {
  const v = typeof name === 'string' ? name.trim() : ''
  if (v.length < 1 || v.length > 100) {
    throw new DomainError('invalid_input', `${label} name must be 1 to 100 characters.`)
  }
  return v
}

function parseSortOrder(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > INT4_MAX) {
    throw new DomainError('invalid_input', 'Sort order must be a whole number.')
  }
  return v
}

/** Trim and lower-case one attribute key; `invalid_input` unless it matches the key format. */
export function normalizeAttributeKey(key: unknown): string {
  const k = typeof key === 'string' ? key.trim().toLowerCase() : ''
  if (!ATTRIBUTE_KEY_RE.test(k)) {
    throw new DomainError(
      'invalid_input',
      'Attribute names start with a letter and use only letters, digits and underscores (up to 30).',
    )
  }
  return k
}

/** Normalize a list of group attribute keys: at most 5, no duplicates. */
export function normalizeAttributeKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) throw new DomainError('invalid_input', 'Attributes must be a list.')
  if (keys.length > MAX_ATTRIBUTE_KEYS) {
    throw new DomainError('invalid_input', `A group can have at most ${MAX_ATTRIBUTE_KEYS} attributes.`)
  }
  const out = keys.map(normalizeAttributeKey)
  if (new Set(out).size !== out.length) {
    throw new DomainError('invalid_input', 'Attribute names must be different from each other.')
  }
  return out
}

function toCategory(r: typeof categories.$inferSelect): Category {
  return { id: r.id, parentId: r.parentId, name: r.name, sortOrder: r.sortOrder, active: r.active }
}
function toBrand(r: typeof brands.$inferSelect): Brand {
  return { id: r.id, name: r.name, active: r.active }
}
function toGroup(r: typeof itemGroups.$inferSelect): ItemGroup {
  return {
    id: r.id,
    name: r.name,
    categoryId: r.categoryId,
    brandId: r.brandId,
    attributeKeys: r.attributeKeys,
    active: r.active,
  }
}

const nameTaken = (what: string) => new DomainError('conflict', `${what} with that name already exists.`)

/** Run a write; a unique violation that raced past the service check becomes `conflict`. */
async function mapRace<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (isUniqueViolation(e)) throw nameTaken(what)
    throw e
  }
}

// ---------------------------------------------------------------- categories

export type CategoryInput = { name: string; parentId: string | null; sortOrder?: number }
export type ValidCategory = { name: string; parentId: string | null; sortOrder: number }

export function validateCategoryInput(i: CategoryInput): ValidCategory {
  return {
    name: parseName(i.name, 'Category'),
    parentId: i.parentId ?? null,
    sortOrder: i.sortOrder === undefined ? 0 : parseSortOrder(i.sortOrder),
  }
}

/** The parent must be an existing top-level category of the business. */
async function assertParentTx(tx: Tx, ctx: TenantCtx, parentId: string): Promise<void> {
  if (typeof parentId !== 'string' || !isUuid(parentId)) throw new DomainError('not_found')
  const [p] = await tx
    .select({ parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.id, parentId), eq(categories.businessId, ctx.businessId)))
  if (!p) throw new DomainError('not_found')
  if (p.parentId !== null) {
    throw new DomainError('invalid_input', 'A subcategory can only go under a top-level category.')
  }
}

async function findCategoryByNameTx(
  tx: Tx,
  ctx: TenantCtx,
  name: string,
  parentId: string | null,
  excludeId?: string,
) {
  const [row] = await tx
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.businessId, ctx.businessId),
        parentId === null ? sql`${categories.parentId} is null` : eq(categories.parentId, parentId),
        sql`lower(${categories.name}) = lower(${name})`,
        excludeId ? ne(categories.id, excludeId) : undefined,
      ),
    )
  return row
}

/** Insert a validated category (parent check, duplicate check, audit). Call inside a transaction. */
export async function insertCategoryTx(tx: Tx, ctx: TenantCtx, v: ValidCategory): Promise<Category> {
  if (v.parentId !== null) await assertParentTx(tx, ctx, v.parentId)
  if (await findCategoryByNameTx(tx, ctx, v.name, v.parentId)) throw nameTaken('A category')
  const [row] = await tx
    .insert(categories)
    .values({ businessId: ctx.businessId, ...v })
    .returning()
  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'category.create',
    entityType: 'category',
    entityId: row.id,
    data: v,
  })
  return toCategory(row)
}

/** Case-insensitive lookup of a category by name under `parentId`; creates it when missing. */
export async function findOrCreateCategoryTx(
  tx: Tx,
  ctx: TenantCtx,
  name: string,
  parentId: string | null,
): Promise<Category> {
  const v = validateCategoryInput({ name, parentId })
  if (v.parentId !== null) await assertParentTx(tx, ctx, v.parentId)
  const existing = await findCategoryByNameTx(tx, ctx, v.name, v.parentId)
  if (existing) return toCategory(existing)
  return insertCategoryTx(tx, ctx, v)
}

export async function listCategories(db: Db, ctx: TenantCtx): Promise<Category[]> {
  const rows = await db
    .select()
    .from(categories)
    .where(eq(categories.businessId, ctx.businessId))
    .orderBy(asc(categories.sortOrder), asc(categories.name))
  return rows.map(toCategory)
}

export async function createCategory(db: Db, ctx: TenantCtx, i: CategoryInput): Promise<Category> {
  assertCan(ctx, 'catalog.manage')
  const v = validateCategoryInput(i)
  if (v.parentId !== null && !isUuid(v.parentId)) throw new DomainError('not_found')
  return mapRace('A category', () => db.transaction((tx) => insertCategoryTx(tx, ctx, v)))
}

export async function updateCategory(
  db: Db,
  ctx: TenantCtx,
  id: string,
  patch: Partial<{ name: string; parentId: string | null; sortOrder: number; active: boolean }>,
): Promise<Category> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(id)) throw new DomainError('not_found')
  const set: Partial<Pick<typeof categories.$inferInsert, 'name' | 'parentId' | 'sortOrder' | 'active'>> = {}
  if (patch.name !== undefined) set.name = parseName(patch.name, 'Category')
  if (patch.sortOrder !== undefined) set.sortOrder = parseSortOrder(patch.sortOrder)
  if (patch.active !== undefined) set.active = patch.active === true
  if (patch.parentId !== undefined) {
    if (patch.parentId !== null && !isUuid(patch.parentId)) throw new DomainError('not_found')
    set.parentId = patch.parentId
  }

  return mapRace('A category', () =>
    db.transaction(async (tx) => {
      const scope = and(eq(categories.id, id), eq(categories.businessId, ctx.businessId))
      const [existing] = await tx.select().from(categories).where(scope).for('update')
      if (!existing) throw new DomainError('not_found')

      if (set.parentId !== undefined && set.parentId !== null) {
        if (set.parentId === id) throw new DomainError('invalid_input', 'A category cannot be its own parent.')
        await assertParentTx(tx, ctx, set.parentId)
        const [child] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.parentId, id), eq(categories.businessId, ctx.businessId)))
          .limit(1)
        if (child) {
          throw new DomainError('invalid_input', 'A category with subcategories cannot become a subcategory.')
        }
      }
      if (set.name !== undefined || set.parentId !== undefined) {
        const name = set.name ?? existing.name
        const parentId = set.parentId !== undefined ? set.parentId : existing.parentId
        if (await findCategoryByNameTx(tx, ctx, name, parentId, id)) throw nameTaken('A category')
      }

      let row = existing
      if (Object.keys(set).length > 0) {
        ;[row] = await tx
          .update(categories)
          .set({ ...set, updatedAt: new Date() })
          .where(scope)
          .returning()
      }
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'category.update',
        entityType: 'category',
        entityId: row.id,
        data: { before: toCategory(existing), after: toCategory(row) },
      })
      return toCategory(row)
    }),
  )
}

// -------------------------------------------------------------------- brands

export type ValidBrand = { name: string }

export function validateBrandInput(i: { name: string }): ValidBrand {
  return { name: parseName(i.name, 'Brand') }
}

async function findBrandByNameTx(tx: Tx, ctx: TenantCtx, name: string, excludeId?: string) {
  const [row] = await tx
    .select()
    .from(brands)
    .where(
      and(
        eq(brands.businessId, ctx.businessId),
        sql`lower(${brands.name}) = lower(${name})`,
        excludeId ? ne(brands.id, excludeId) : undefined,
      ),
    )
  return row
}

/** Insert a validated brand (duplicate check, audit). Call inside a transaction. */
export async function insertBrandTx(tx: Tx, ctx: TenantCtx, v: ValidBrand): Promise<Brand> {
  if (await findBrandByNameTx(tx, ctx, v.name)) throw nameTaken('A brand')
  const [row] = await tx.insert(brands).values({ businessId: ctx.businessId, name: v.name }).returning()
  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'brand.create',
    entityType: 'brand',
    entityId: row.id,
    data: v,
  })
  return toBrand(row)
}

/** Case-insensitive lookup of a brand by name; creates it when missing. */
export async function findOrCreateBrandTx(tx: Tx, ctx: TenantCtx, name: string): Promise<Brand> {
  const v = validateBrandInput({ name })
  const existing = await findBrandByNameTx(tx, ctx, v.name)
  if (existing) return toBrand(existing)
  return insertBrandTx(tx, ctx, v)
}

export async function listBrands(db: Db, ctx: TenantCtx): Promise<Brand[]> {
  const rows = await db.select().from(brands).where(eq(brands.businessId, ctx.businessId)).orderBy(asc(brands.name))
  return rows.map(toBrand)
}

export async function createBrand(db: Db, ctx: TenantCtx, i: { name: string }): Promise<Brand> {
  assertCan(ctx, 'catalog.manage')
  const v = validateBrandInput(i)
  return mapRace('A brand', () => db.transaction((tx) => insertBrandTx(tx, ctx, v)))
}

export async function updateBrand(
  db: Db,
  ctx: TenantCtx,
  id: string,
  patch: Partial<{ name: string; active: boolean }>,
): Promise<Brand> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(id)) throw new DomainError('not_found')
  const set: Partial<Pick<typeof brands.$inferInsert, 'name' | 'active'>> = {}
  if (patch.name !== undefined) set.name = parseName(patch.name, 'Brand')
  if (patch.active !== undefined) set.active = patch.active === true

  return mapRace('A brand', () =>
    db.transaction(async (tx) => {
      const scope = and(eq(brands.id, id), eq(brands.businessId, ctx.businessId))
      const [existing] = await tx.select().from(brands).where(scope).for('update')
      if (!existing) throw new DomainError('not_found')
      if (set.name !== undefined && (await findBrandByNameTx(tx, ctx, set.name, id))) {
        throw nameTaken('A brand')
      }
      let row = existing
      if (Object.keys(set).length > 0) {
        ;[row] = await tx.update(brands).set(set).where(scope).returning()
      }
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'brand.update',
        entityType: 'brand',
        entityId: row.id,
        data: { before: toBrand(existing), after: toBrand(row) },
      })
      return toBrand(row)
    }),
  )
}

// -------------------------------------------------------------------- groups

export type GroupInput = {
  name: string
  categoryId?: string | null
  brandId?: string | null
  attributeKeys: string[]
}
export type ValidGroup = {
  name: string
  categoryId: string | null
  brandId: string | null
  attributeKeys: string[]
}

export function validateGroupInput(i: GroupInput): ValidGroup {
  return {
    name: parseName(i.name, 'Group'),
    categoryId: i.categoryId ?? null,
    brandId: i.brandId ?? null,
    attributeKeys: normalizeAttributeKeys(i.attributeKeys),
  }
}

/** A category or brand reference must belong to the business; anything else is `not_found`. */
async function assertGroupRefsTx(
  tx: Tx,
  ctx: TenantCtx,
  refs: { categoryId: string | null; brandId: string | null },
): Promise<void> {
  if (refs.categoryId !== null) {
    if (typeof refs.categoryId !== 'string' || !isUuid(refs.categoryId)) throw new DomainError('not_found')
    const [c] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, refs.categoryId), eq(categories.businessId, ctx.businessId)))
    if (!c) throw new DomainError('not_found')
  }
  if (refs.brandId !== null) {
    if (typeof refs.brandId !== 'string' || !isUuid(refs.brandId)) throw new DomainError('not_found')
    const [b] = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.id, refs.brandId), eq(brands.businessId, ctx.businessId)))
    if (!b) throw new DomainError('not_found')
  }
}

async function findGroupByNameTx(tx: Tx, ctx: TenantCtx, name: string, excludeId?: string) {
  const [row] = await tx
    .select()
    .from(itemGroups)
    .where(
      and(
        eq(itemGroups.businessId, ctx.businessId),
        sql`lower(${itemGroups.name}) = lower(${name})`,
        excludeId ? ne(itemGroups.id, excludeId) : undefined,
      ),
    )
  return row
}

/** Insert a validated group (reference checks, duplicate check, audit). Call inside a transaction. */
export async function insertGroupTx(tx: Tx, ctx: TenantCtx, v: ValidGroup): Promise<ItemGroup> {
  await assertGroupRefsTx(tx, ctx, v)
  if (await findGroupByNameTx(tx, ctx, v.name)) throw nameTaken('A group')
  const [row] = await tx
    .insert(itemGroups)
    .values({ businessId: ctx.businessId, ...v })
    .returning()
  await recordAudit(tx, {
    businessId: ctx.businessId,
    actorUserId: ctx.userId,
    action: 'group.create',
    entityType: 'item_group',
    entityId: row.id,
    data: v,
  })
  return toGroup(row)
}

/** Case-insensitive lookup of a group by name; creates it (no attribute keys, no category or brand) when missing. */
export async function findOrCreateGroupTx(tx: Tx, ctx: TenantCtx, name: string): Promise<ItemGroup> {
  const v = validateGroupInput({ name, attributeKeys: [] })
  const existing = await findGroupByNameTx(tx, ctx, v.name)
  if (existing) return toGroup(existing)
  return insertGroupTx(tx, ctx, v)
}

export async function listGroups(db: Db, ctx: TenantCtx): Promise<ItemGroup[]> {
  const rows = await db
    .select()
    .from(itemGroups)
    .where(eq(itemGroups.businessId, ctx.businessId))
    .orderBy(asc(itemGroups.name))
  return rows.map(toGroup)
}

export async function createGroup(db: Db, ctx: TenantCtx, i: GroupInput): Promise<ItemGroup> {
  assertCan(ctx, 'catalog.manage')
  const v = validateGroupInput(i)
  return mapRace('A group', () => db.transaction((tx) => insertGroupTx(tx, ctx, v)))
}

export async function updateGroup(
  db: Db,
  ctx: TenantCtx,
  id: string,
  patch: Partial<{
    name: string
    categoryId: string | null
    brandId: string | null
    attributeKeys: string[]
    active: boolean
  }>,
): Promise<ItemGroup> {
  assertCan(ctx, 'catalog.manage')
  if (!isUuid(id)) throw new DomainError('not_found')
  const set: Partial<
    Pick<typeof itemGroups.$inferInsert, 'name' | 'categoryId' | 'brandId' | 'attributeKeys' | 'active'>
  > = {}
  if (patch.name !== undefined) set.name = parseName(patch.name, 'Group')
  if (patch.categoryId !== undefined) set.categoryId = patch.categoryId
  if (patch.brandId !== undefined) set.brandId = patch.brandId
  if (patch.attributeKeys !== undefined) set.attributeKeys = normalizeAttributeKeys(patch.attributeKeys)
  if (patch.active !== undefined) set.active = patch.active === true

  return mapRace('A group', () =>
    db.transaction(async (tx) => {
      const scope = and(eq(itemGroups.id, id), eq(itemGroups.businessId, ctx.businessId))
      const [existing] = await tx.select().from(itemGroups).where(scope).for('update')
      if (!existing) throw new DomainError('not_found')
      await assertGroupRefsTx(tx, ctx, {
        categoryId: set.categoryId === undefined ? null : set.categoryId,
        brandId: set.brandId === undefined ? null : set.brandId,
      })
      if (set.name !== undefined && (await findGroupByNameTx(tx, ctx, set.name, id))) {
        throw nameTaken('A group')
      }
      let row = existing
      if (Object.keys(set).length > 0) {
        ;[row] = await tx
          .update(itemGroups)
          .set({ ...set, updatedAt: new Date() })
          .where(scope)
          .returning()
      }
      await recordAudit(tx, {
        businessId: ctx.businessId,
        actorUserId: ctx.userId,
        action: 'group.update',
        entityType: 'item_group',
        entityId: row.id,
        data: { before: toGroup(existing), after: toGroup(row) },
      })
      return toGroup(row)
    }),
  )
}
