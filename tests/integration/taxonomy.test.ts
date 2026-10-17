import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, categories } from '@/db/schema'
import { DomainError } from '@/server/errors'
import { createStaff } from '@/server/services/staff'
import {
  createBrand,
  createCategory,
  createGroup,
  findOrCreateBrandTx,
  findOrCreateCategoryTx,
  listBrands,
  listCategories,
  listGroups,
  updateBrand,
  updateCategory,
  updateGroup,
} from '@/server/services/taxonomy'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

async function setup() {
  const seeded = await seedBusiness({ outletCodes: ['KTL'] })
  const ctx = (await getTenantCtx(db, seeded.owner.userId))!
  return { ...seeded, ctx }
}

async function manager(ctx: TenantCtx, outletId: string): Promise<TenantCtx> {
  const m = await createStaff(db, ctx, {
    name: 'Mgr',
    email: `mgr-${Math.random().toString(36).slice(2)}@staff.test`,
    role: 'manager',
    outletIds: [outletId],
    tempPassword: 'temp-pass-1234',
  })
  return (await getTenantCtx(db, m.userId))!
}

async function auditCount(businessId: string, action: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, action)))
  return rows.length
}

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DomainError)
  expect((err as DomainError).code).toBe(code)
}

describe('categories', () => {
  beforeEach(resetDb)

  it('creates and lists ordered by sort order then name', async () => {
    const { ctx, businessId } = await setup()
    await createCategory(db, ctx, { name: 'Zinc', parentId: null, sortOrder: 1 })
    await createCategory(db, ctx, { name: ' Roofing ', parentId: null, sortOrder: 1 })
    await createCategory(db, ctx, { name: 'Paint', parentId: null, sortOrder: 0 })
    const list = await listCategories(db, ctx)
    expect(list.map((c) => c.name)).toEqual(['Paint', 'Roofing', 'Zinc'])
    expect(list[0]).toMatchObject({ parentId: null, sortOrder: 0, active: true })
    expect(await auditCount(businessId, 'category.create')).toBe(3)
  })

  it('refuses a manager', async () => {
    const { ctx, outletIds } = await setup()
    const mgr = await manager(ctx, outletIds[0])
    await rejects(createCategory(db, mgr, { name: 'X', parentId: null }), 'forbidden')
    const c = await createCategory(db, ctx, { name: 'Y', parentId: null })
    await rejects(updateCategory(db, mgr, c.id, { name: 'Z' }), 'forbidden')
    // reads are open
    expect(await listCategories(db, mgr)).toHaveLength(1)
  })

  it('rejects bad names', async () => {
    const { ctx } = await setup()
    await rejects(createCategory(db, ctx, { name: '   ', parentId: null }), 'invalid_input')
    await rejects(createCategory(db, ctx, { name: 'x'.repeat(101), parentId: null }), 'invalid_input')
    expect((await createCategory(db, ctx, { name: 'x'.repeat(100), parentId: null })).name).toHaveLength(100)
  })

  it('treats names as duplicates case-insensitively within the same parent', async () => {
    const { ctx } = await setup()
    const a = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const b = await createCategory(db, ctx, { name: 'Paint', parentId: null })
    await rejects(createCategory(db, ctx, { name: ' ROOFING ', parentId: null }), 'conflict')
    await createCategory(db, ctx, { name: 'Sheets', parentId: a.id })
    await rejects(createCategory(db, ctx, { name: 'sheets', parentId: a.id }), 'conflict')
    // the same name under another parent is fine
    await createCategory(db, ctx, { name: 'Sheets', parentId: b.id })
    await rejects(updateCategory(db, ctx, b.id, { name: 'roofing' }), 'conflict')
  })

  it('maps a concurrent same-name create to conflict, not a raw database error', async () => {
    const { ctx, businessId } = await setup()
    const results = await Promise.allSettled([
      createCategory(db, ctx, { name: 'Race', parentId: null }),
      createCategory(db, ctx, { name: 'Race', parentId: null }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(DomainError)
    expect((rejected.reason as DomainError).code).toBe('conflict')
    expect(await auditCount(businessId, 'category.create')).toBe(1)
  })

  it('validates the parent', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const foreign = await createCategory(db, other.ctx, { name: 'Foreign', parentId: null })
    const top = await createCategory(db, ctx, { name: 'Top', parentId: null })
    const child = await createCategory(db, ctx, { name: 'Child', parentId: top.id })

    await rejects(createCategory(db, ctx, { name: 'A', parentId: foreign.id }), 'not_found')
    await rejects(createCategory(db, ctx, { name: 'A', parentId: 'nope' }), 'not_found')
    await rejects(createCategory(db, ctx, { name: 'A', parentId: crypto.randomUUID() }), 'not_found')
    await rejects(createCategory(db, ctx, { name: 'A', parentId: child.id }), 'invalid_input')
    expect(child.parentId).toBe(top.id)
  })

  it('refuses self-parent and a parent that has children', async () => {
    const { ctx } = await setup()
    const top = await createCategory(db, ctx, { name: 'Top', parentId: null })
    const other = await createCategory(db, ctx, { name: 'Other', parentId: null })
    await createCategory(db, ctx, { name: 'Child', parentId: top.id })
    await rejects(updateCategory(db, ctx, top.id, { parentId: top.id }), 'invalid_input')
    await rejects(updateCategory(db, ctx, top.id, { parentId: other.id }), 'invalid_input')
    // a childless category can move under a parent, and back to top level
    const moved = await updateCategory(db, ctx, other.id, { parentId: top.id })
    expect(moved.parentId).toBe(top.id)
    expect((await updateCategory(db, ctx, other.id, { parentId: null })).parentId).toBeNull()
  })

  it('updates with before/after audit, and refuses another business id with no change', async () => {
    const { ctx, businessId } = await setup()
    const other = await setup()
    const c = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const u = await updateCategory(db, ctx, c.id, { name: 'Roof', sortOrder: 4, active: false })
    expect(u).toMatchObject({ name: 'Roof', sortOrder: 4, active: false })
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'category.update')))
    expect(audit.entityId).toBe(c.id)
    expect(audit.data).toMatchObject({
      before: { name: 'Roofing', sortOrder: 0, active: true },
      after: { name: 'Roof', sortOrder: 4, active: false },
    })

    await rejects(updateCategory(db, other.ctx, c.id, { name: 'Hacked' }), 'not_found')
    await rejects(updateCategory(db, ctx, 'not-a-uuid', { name: 'X' }), 'not_found')
    const [row] = await db.select().from(categories).where(eq(categories.id, c.id))
    expect(row.name).toBe('Roof')
    expect(await auditCount(businessId, 'category.update')).toBe(1)
    expect(await auditCount(other.businessId, 'category.update')).toBe(0)
  })

  it('findOrCreateCategoryTx matches case-insensitively and creates when missing', async () => {
    const { ctx, businessId } = await setup()
    const a = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    await db.transaction(async (tx) => {
      const found = await findOrCreateCategoryTx(tx, ctx, ' roofing', null)
      expect(found.id).toBe(a.id)
      const created = await findOrCreateCategoryTx(tx, ctx, 'Sheets', a.id)
      expect(created.parentId).toBe(a.id)
    })
    expect(await auditCount(businessId, 'category.create')).toBe(2)
  })
})

describe('brands', () => {
  beforeEach(resetDb)

  it('creates, lists, updates and audits', async () => {
    const { ctx, businessId } = await setup()
    const b = await createBrand(db, ctx, { name: ' Bamburi ' })
    await createBrand(db, ctx, { name: 'Crown' })
    expect((await listBrands(db, ctx)).map((x) => x.name)).toEqual(['Bamburi', 'Crown'])
    const u = await updateBrand(db, ctx, b.id, { name: 'Bamburi Cement', active: false })
    expect(u).toMatchObject({ name: 'Bamburi Cement', active: false })
    expect(await auditCount(businessId, 'brand.create')).toBe(2)
    expect(await auditCount(businessId, 'brand.update')).toBe(1)
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'brand.update')))
    expect(audit.data).toMatchObject({ before: { name: 'Bamburi' }, after: { name: 'Bamburi Cement' } })
  })

  it('refuses managers, bad names, duplicates (any case), and another business id', async () => {
    const { ctx, outletIds } = await setup()
    const other = await setup()
    const mgr = await manager(ctx, outletIds[0])
    await rejects(createBrand(db, mgr, { name: 'X' }), 'forbidden')
    await rejects(createBrand(db, ctx, { name: '' }), 'invalid_input')
    const b = await createBrand(db, ctx, { name: 'Crown' })
    await createBrand(db, ctx, { name: 'Duracoat' })
    await rejects(createBrand(db, ctx, { name: 'CROWN' }), 'conflict')
    await rejects(updateBrand(db, ctx, b.id, { name: 'duracoat' }), 'conflict')
    await rejects(updateBrand(db, other.ctx, b.id, { name: 'Mine' }), 'not_found')
    await rejects(updateBrand(db, ctx, 'bad', { name: 'Mine' }), 'not_found')
    await rejects(updateBrand(db, mgr, b.id, { name: 'Mine' }), 'forbidden')
    // the same brand name is fine in another business
    await createBrand(db, other.ctx, { name: 'Crown' })
  })

  it('findOrCreateBrandTx reuses an existing brand regardless of case', async () => {
    const { ctx } = await setup()
    const b = await createBrand(db, ctx, { name: 'Crown' })
    await db.transaction(async (tx) => {
      expect((await findOrCreateBrandTx(tx, ctx, 'CROWN')).id).toBe(b.id)
      expect((await findOrCreateBrandTx(tx, ctx, 'New')).name).toBe('New')
    })
    expect(await listBrands(db, ctx)).toHaveLength(2)
  })
})

describe('item groups', () => {
  beforeEach(resetDb)

  it('creates a group with normalized attribute keys and audits', async () => {
    const { ctx, businessId } = await setup()
    const cat = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const brand = await createBrand(db, ctx, { name: 'Crown' })
    const g = await createGroup(db, ctx, {
      name: ' Iron sheets ',
      categoryId: cat.id,
      brandId: brand.id,
      attributeKeys: ['Size', ' gauge '],
    })
    expect(g).toMatchObject({
      name: 'Iron sheets',
      categoryId: cat.id,
      brandId: brand.id,
      attributeKeys: ['size', 'gauge'],
      active: true,
    })
    const bare = await createGroup(db, ctx, { name: 'Misc', attributeKeys: [] })
    expect(bare).toMatchObject({ categoryId: null, brandId: null, attributeKeys: [] })
    expect((await listGroups(db, ctx)).map((x) => x.name)).toEqual(['Iron sheets', 'Misc'])
    expect(await auditCount(businessId, 'group.create')).toBe(2)
  })

  it('validates attribute keys', async () => {
    const { ctx, businessId } = await setup()
    await rejects(createGroup(db, ctx, { name: 'A', attributeKeys: ['1size'] }), 'invalid_input')
    await rejects(createGroup(db, ctx, { name: 'A', attributeKeys: ['has space'] }), 'invalid_input')
    await rejects(createGroup(db, ctx, { name: 'A', attributeKeys: ['a'.repeat(31)] }), 'invalid_input')
    await rejects(createGroup(db, ctx, { name: 'A', attributeKeys: ['size', 'SIZE'] }), 'invalid_input')
    await rejects(
      createGroup(db, ctx, { name: 'A', attributeKeys: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      'invalid_input',
    )
    const ok = await createGroup(db, ctx, { name: 'A', attributeKeys: ['a', 'b', 'c', 'd', 'e'] })
    expect(ok.attributeKeys).toHaveLength(5)
    expect(await auditCount(businessId, 'group.create')).toBe(1)
  })

  it('refuses managers, duplicate names, and cross-business references', async () => {
    const { ctx, outletIds } = await setup()
    const other = await setup()
    const mgr = await manager(ctx, outletIds[0])
    const foreignCat = await createCategory(db, other.ctx, { name: 'Foreign', parentId: null })
    const foreignBrand = await createBrand(db, other.ctx, { name: 'Foreign' })

    await rejects(createGroup(db, mgr, { name: 'G', attributeKeys: [] }), 'forbidden')
    await rejects(
      createGroup(db, ctx, { name: 'G', categoryId: foreignCat.id, attributeKeys: [] }),
      'not_found',
    )
    await rejects(
      createGroup(db, ctx, { name: 'G', brandId: foreignBrand.id, attributeKeys: [] }),
      'not_found',
    )
    await rejects(createGroup(db, ctx, { name: 'G', categoryId: 'bad', attributeKeys: [] }), 'not_found')
    const g = await createGroup(db, ctx, { name: 'Sheets', attributeKeys: [] })
    await rejects(createGroup(db, ctx, { name: 'sheets', attributeKeys: [] }), 'conflict')
    await createGroup(db, other.ctx, { name: 'Sheets', attributeKeys: [] })

    await rejects(updateGroup(db, ctx, g.id, { categoryId: foreignCat.id }), 'not_found')
    await rejects(updateGroup(db, ctx, g.id, { brandId: foreignBrand.id }), 'not_found')
    await rejects(updateGroup(db, other.ctx, g.id, { name: 'Mine' }), 'not_found')
    await rejects(updateGroup(db, mgr, g.id, { name: 'Mine' }), 'forbidden')
    await rejects(updateGroup(db, ctx, 'bad', { name: 'Mine' }), 'not_found')
  })

  it('updates fields, clears references, and records before/after', async () => {
    const { ctx, businessId } = await setup()
    const cat = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const g = await createGroup(db, ctx, { name: 'Sheets', categoryId: cat.id, attributeKeys: ['size'] })
    const u = await updateGroup(db, ctx, g.id, {
      name: 'Iron sheets',
      categoryId: null,
      attributeKeys: ['Gauge'],
      active: false,
    })
    expect(u).toMatchObject({ name: 'Iron sheets', categoryId: null, attributeKeys: ['gauge'], active: false })
    await rejects(updateGroup(db, ctx, g.id, { attributeKeys: ['9'] }), 'invalid_input')
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'group.update')))
    expect(audit.data).toMatchObject({
      before: { name: 'Sheets', categoryId: cat.id, attributeKeys: ['size'] },
      after: { name: 'Iron sheets', categoryId: null, attributeKeys: ['gauge'] },
    })
    expect(await auditCount(businessId, 'group.update')).toBe(1)
  })
})
