import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import {
  auditLog,
  brands,
  categories,
  itemBarcodes,
  itemGroups,
  itemPacks,
  items,
  outletStock,
  outlets,
  stockMovements,
} from '@/db/schema'
import { IMPORT_COLUMNS } from '@/domain/catalog-import'
import { toCsv } from '@/domain/csv'
import { DomainError } from '@/server/errors'
import { applyImport, previewImport } from '@/server/services/catalog-import'
import { createItem, type ItemInput } from '@/server/services/items'
import { createStaff } from '@/server/services/staff'
import { createBrand, createCategory } from '@/server/services/taxonomy'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

async function setup(outletCodes = ['KTL']) {
  const seeded = await seedBusiness({ outletCodes })
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

async function expectDomain(p: Promise<unknown>, code: DomainError['code'], message?: string | RegExp) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DomainError)
  expect((err as DomainError).code).toBe(code)
  if (typeof message === 'string') expect((err as DomainError).message).toBe(message)
  else if (message) expect((err as DomainError).message).toMatch(message)
}

/** Build CSV text from a partial-column table: rows are objects keyed by column name. */
function csv(rows: Record<string, string>[], extra: string[] = ['stock_KTL']): string {
  const cols = [...IMPORT_COLUMNS, ...extra]
  return toCsv([cols, ...rows.map((r) => cols.map((c) => r[c] ?? ''))])
}

const sheet = {
  name: 'Iron sheet 30G 3m',
  category: 'Roofing',
  subcategory: 'Iron sheets',
  brand: 'Mabati',
  sku: 'IS-1',
  barcode: '6001',
  base_unit: 'Sheet',
  price: '950',
  floor: '900',
  low_stock: '10',
  pack1_name: 'Bundle',
  pack1_qty: '20',
  pack1_price: '18,000',
  pack1_barcode: '6002',
  stock_KTL: '25',
}
const mesh = { name: 'Wire mesh', group: 'Mesh', base_unit: 'm', fractional: 'yes', price: '200.50', sku: 'WM-1' }

async function counts() {
  const n = (t: Parameters<typeof db.$count>[0]) => db.$count(t)
  return {
    items: await n(items),
    packs: await n(itemPacks),
    barcodes: await n(itemBarcodes),
    categories: await n(categories),
    brands: await n(brands),
    groups: await n(itemGroups),
    movements: await n(stockMovements),
    stock: await n(outletStock),
    audit: await n(auditLog),
  }
}

describe('previewImport', () => {
  beforeEach(resetDb)

  it('summarises a clean file and lists what would be created, matching names case-insensitively', async () => {
    const { ctx } = await setup()
    await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    await createBrand(db, ctx, { name: 'mabati' })
    const text = csv([
      sheet,
      { ...mesh, category: 'ROOFING', brand: 'Acme' },
      { ...mesh, name: 'Wire mesh 2', sku: 'WM-2', category: 'Plumbing', group: 'mesh' },
    ])
    const p = await previewImport(db, ctx, text)
    expect(p.errors).toEqual([])
    expect(p).toMatchObject({
      rowCount: 3,
      itemCount: 3,
      packCount: 1,
      stockCells: 1,
      newCategories: ['Roofing > Iron sheets', 'Plumbing'],
      newBrands: ['Acme'],
      newGroups: ['Mesh'],
    })
  })

  it('reports an existing SKU and an existing barcode on their lines, case-insensitively', async () => {
    const { ctx } = await setup()
    const base: ItemInput = {
      name: 'Old',
      baseUnit: 'pc',
      fractional: false,
      priceCents: 100,
      floorCents: 100,
      lowStockMilli: null,
      sku: 'ABC-1',
    }
    const { addBarcode } = await import('@/server/services/items')
    const old = await createItem(db, ctx, base)
    await addBarcode(db, ctx, old.id, { barcode: '555', packId: null })
    const text = csv([
      { name: 'A', base_unit: 'pc', price: '1', sku: 'abc-1' },
      { name: 'B', base_unit: 'pc', price: '1', sku: 'NEW-1', barcode: '555' },
      { name: 'C', base_unit: 'pc', price: '1', sku: 'NEW-2', pack1_name: 'Box', pack1_qty: '6', pack1_price: '5', pack1_barcode: '555' },
      { name: 'D', base_unit: 'pc', price: '1', sku: 'NEW-3' },
    ])
    const p = await previewImport(db, ctx, text)
    expect(p.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 'sku'],
      [3, 'barcode'],
      [4, 'pack1_barcode'],
    ])
    expect(p.itemCount).toBe(1)
  })

  it('does not collide with another business', async () => {
    const a = await setup()
    const b = await setup()
    await createItem(db, b.ctx, {
      name: 'Theirs', baseUnit: 'pc', fractional: false, priceCents: 1, floorCents: 1, lowStockMilli: null, sku: 'SAME',
    })
    const p = await previewImport(db, a.ctx, csv([{ name: 'Mine', base_unit: 'pc', price: '1', sku: 'same' }]))
    expect(p.errors).toEqual([])
  })

  it('runs rows through the item rules and reports the line and column', async () => {
    const { ctx } = await setup()
    const p = await previewImport(
      db,
      ctx,
      csv([
        { name: 'A', base_unit: 'pc', price: '10', floor: '20' },
        { name: 'B'.repeat(201), base_unit: 'pc', price: '10' },
        { name: 'C', base_unit: 'pc', price: '10', barcode: 'bad code!' },
        { name: 'D', base_unit: 'pc', price: '10', pack1_name: 'Box', pack1_qty: '0', pack1_price: '5' },
        { name: 'E', base_unit: 'pc', price: '10', pack1_name: 'Box', pack1_qty: '6', pack1_price: '5', pack1_floor: '9' },
        { name: 'F', base_unit: 'u'.repeat(21), price: '10' },
      ]),
    )
    expect(p.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 'floor'],
      [3, 'name'],
      [4, 'barcode'],
      [5, 'pack1_qty'],
      [6, 'pack1_floor'],
      [7, 'base_unit'],
    ])
    expect(p.errors[0].message).toBe("The lowest price can't be above the price.")
    expect(p.itemCount).toBe(0)
  })

  it('reports an unknown or other-business outlet code, and an unterminated quote', async () => {
    const a = await setup(['KTL'])
    await setup(['OTH'])
    const unknown = await previewImport(
      db,
      a.ctx,
      toCsv([['name', 'base_unit', 'price', 'stock_OTH'], ['A', 'pc', '1', '5']]),
    )
    expect(unknown.errors).toEqual([expect.objectContaining({ line: 1, column: 'stock_OTH' })])

    const broken = await previewImport(db, a.ctx, 'name,base_unit,price\n"A,pc,1')
    expect(broken.errors).toEqual([expect.objectContaining({ line: null })])
    expect(broken.itemCount).toBe(0)
  })

  it('treats a deactivated outlet as unknown', async () => {
    const { ctx, outletIds } = await setup(['KTL'])
    await db.update(outlets).set({ active: false }).where(eq(outlets.id, outletIds[0]))
    const p = await previewImport(db, ctx, toCsv([['name', 'base_unit', 'price', 'stock_KTL'], ['A', 'pc', '1', '5']]))
    expect(p.errors).toEqual([expect.objectContaining({ line: 1, column: 'stock_KTL' })])
  })

  it('refuses text over 2,000,000 characters and a manager', async () => {
    const { ctx, outletIds } = await setup()
    await expectDomain(previewImport(db, ctx, 'x'.repeat(2_000_001)), 'invalid_input')
    const mgr = await manager(ctx, outletIds[0])
    await expectDomain(previewImport(db, mgr, csv([sheet])), 'forbidden')
  })

  it('writes nothing', async () => {
    const { ctx } = await setup()
    const before = await counts()
    await previewImport(db, ctx, csv([sheet, mesh]))
    expect(await counts()).toEqual(before)
  })
})

describe('applyImport', () => {
  beforeEach(resetDb)

  it('creates taxonomy, items, packs, barcodes and opening stock in one go, with one audit row', async () => {
    const { ctx, outletIds, businessId } = await setup()
    const result = await applyImport(db, ctx, csv([sheet, mesh]))
    expect(result).toEqual({ itemCount: 2, packCount: 1, stockCells: 1 })

    const all = await db.select().from(items).where(eq(items.businessId, businessId))
    expect(all).toHaveLength(2)
    const iron = all.find((i) => i.sku === 'IS-1')!
    const wire = all.find((i) => i.sku === 'WM-1')!
    expect(iron).toMatchObject({
      name: 'Iron sheet 30G 3m',
      baseUnit: 'sheet',
      fractional: false,
      priceCents: 95000,
      floorCents: 90000,
      taxCategory: 'B',
      lowStockMilli: 10000,
      groupId: null,
      attributes: {},
    })
    expect(wire).toMatchObject({ fractional: true, priceCents: 20050, floorCents: 20050 })

    // category -> subcategory, the item sits in the subcategory
    const cats = await db.select().from(categories).where(eq(categories.businessId, businessId))
    const roofing = cats.find((c) => c.name === 'Roofing')!
    const sub = cats.find((c) => c.name === 'Iron sheets')!
    expect(roofing.parentId).toBeNull()
    expect(sub.parentId).toBe(roofing.id)
    expect(iron.categoryId).toBe(sub.id)
    const [brand] = await db.select().from(brands).where(eq(brands.businessId, businessId))
    expect(brand.name).toBe('Mabati')
    expect(iron.brandId).toBe(brand.id)
    const [group] = await db.select().from(itemGroups).where(eq(itemGroups.businessId, businessId))
    expect(group).toMatchObject({ name: 'Mesh', attributeKeys: [] })
    expect(wire.groupId).toBe(group.id)

    const packs = await db.select().from(itemPacks).where(eq(itemPacks.businessId, businessId))
    expect(packs).toHaveLength(1)
    expect(packs[0]).toMatchObject({ itemId: iron.id, name: 'Bundle', baseQtyMilli: 20000, priceCents: 1800000, floorCents: 1800000 })
    const codes = await db.select().from(itemBarcodes).where(eq(itemBarcodes.businessId, businessId))
    expect(codes.map((c) => [c.barcode, c.itemId, c.packId]).sort()).toEqual(
      [
        ['6001', iron.id, null],
        ['6002', iron.id, packs[0].id],
      ].sort(),
    )

    const [stock] = await db.select().from(outletStock).where(eq(outletStock.itemId, iron.id))
    expect(stock).toMatchObject({ outletId: outletIds[0], onHandMilli: 25000 })
    const moves = await db.select().from(stockMovements).where(eq(stockMovements.businessId, businessId))
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatchObject({
      kind: 'receive',
      qtyMilli: 25000,
      note: 'Opening stock',
      actorUserId: ctx.userId,
      outletId: outletIds[0],
      itemId: iron.id,
    })

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'catalog.import')))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ actorUserId: ctx.userId, data: { itemCount: 2, packCount: 1, stockCells: 1 } })
  })

  it('reuses existing taxonomy and writes stock for several outlets', async () => {
    const { ctx, outletIds, businessId } = await setup(['KTL', 'ELD'])
    await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const text = toCsv([
      ['name', 'base_unit', 'price', 'category', 'stock_ktl', 'stock_ELD'],
      ['A', 'pc', '1', 'roofing', '5', '7'],
      ['B', 'pc', '1', 'ROOFING', '', '0'],
    ])
    expect(await applyImport(db, ctx, text)).toEqual({ itemCount: 2, packCount: 0, stockCells: 2 })
    const cats = await db.select().from(categories).where(eq(categories.businessId, businessId))
    expect(cats).toHaveLength(1)
    const stock = await db.select().from(outletStock).where(eq(outletStock.businessId, businessId))
    expect(stock.map((s) => [s.outletId, s.onHandMilli]).sort()).toEqual(
      [
        [outletIds[0], 5000],
        [outletIds[1], 7000],
      ].sort(),
    )
  })

  it('rejects a file with an error and writes nothing', async () => {
    const { ctx } = await setup()
    await createItem(db, ctx, {
      name: 'Old', baseUnit: 'pc', fractional: false, priceCents: 1, floorCents: 1, lowStockMilli: null, sku: 'TAKEN',
    })
    const before = await counts()
    const text = csv([sheet, { ...mesh, sku: 'taken' }])
    await expectDomain(applyImport(db, ctx, text), 'invalid_input', 'Line 3: That SKU is already used.')
    expect(await counts()).toEqual(before)

    await expectDomain(
      applyImport(db, ctx, csv([sheet, { name: 'Bad', base_unit: 'pc', price: 'abc' }])),
      'invalid_input',
      /^Line 3: /,
    )
    expect(await counts()).toEqual(before)
  })

  it('writes nothing when the file has a line-less error', async () => {
    const { ctx } = await setup()
    const before = await counts()
    await expectDomain(applyImport(db, ctx, 'name,base_unit,price\n"A,pc,1'), 'invalid_input')
    expect(await counts()).toEqual(before)
  })

  it('refuses a manager and writes nothing', async () => {
    const { ctx, outletIds } = await setup()
    const mgr = await manager(ctx, outletIds[0])
    const before = await counts()
    await expectDomain(applyImport(db, mgr, csv([sheet])), 'forbidden')
    expect(await counts()).toEqual(before)
  })

  it('applying twice refuses the second run', async () => {
    const { ctx } = await setup()
    await applyImport(db, ctx, csv([sheet]))
    const before = await counts()
    await expectDomain(applyImport(db, ctx, csv([sheet])), 'invalid_input', /^Line 2: /)
    expect(await counts()).toEqual(before)
  })
})
