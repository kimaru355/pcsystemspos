import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, itemBarcodes, items, stockMovements } from '@/db/schema'
import { DomainError } from '@/server/errors'
import {
  addBarcode,
  addPack,
  createItem,
  getItem,
  insertBarcodeTx,
  insertItemTx,
  insertPackTx,
  listItems,
  lookupBarcode,
  normalizeBarcode,
  removeBarcode,
  updateItem,
  updatePack,
  validateItemInput,
  validatePackInput,
  type ItemInput,
} from '@/server/services/items'
import { createStaff } from '@/server/services/staff'
import { createBrand, createCategory, createGroup } from '@/server/services/taxonomy'
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

const sheet: ItemInput = {
  name: 'Iron sheet 30G 3m',
  baseUnit: 'sheet',
  fractional: false,
  priceCents: 95000,
  floorCents: 90000,
  lowStockMilli: null,
}

const mesh: ItemInput = {
  name: 'Wire mesh',
  baseUnit: 'm',
  fractional: true,
  priceCents: 20000,
  floorCents: 15000,
  lowStockMilli: null,
}

async function auditCount(businessId: string, action: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, action)))
  return rows.length
}

async function rejects(p: Promise<unknown>, code: string, message?: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DomainError)
  expect((err as DomainError).code).toBe(code)
  if (message) expect((err as DomainError).message).toBe(message)
}

describe('createItem', () => {
  beforeEach(resetDb)

  it('creates an item with the default tax category B and derived VAT', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, { ...sheet, name: '  Iron sheet 30G 3m ', baseUnit: ' SHEET ' })
    expect(item).toMatchObject({
      name: 'Iron sheet 30G 3m',
      baseUnit: 'sheet',
      fractional: false,
      priceCents: 95000,
      floorCents: 90000,
      taxCategory: 'B',
      vatRateBp: 1600,
      sku: null,
      groupId: null,
      categoryId: null,
      brandId: null,
      attributes: {},
      lowStockMilli: null,
      active: true,
      packs: [],
      barcodes: [],
    })
    expect(await getItem(db, ctx, item.id)).toEqual(item)
    expect(await auditCount(businessId, 'item.create')).toBe(1)
  })

  it('derives VAT from the chosen tax category and rejects an unknown one', async () => {
    const { ctx } = await setup()
    const e = await createItem(db, ctx, { ...sheet, taxCategory: 'E' })
    expect(e).toMatchObject({ taxCategory: 'E', vatRateBp: 800 })
    await rejects(
      createItem(db, ctx, { ...sheet, name: 'Z', taxCategory: 'Z' as never }),
      'invalid_input',
    )
  })

  it('refuses a manager', async () => {
    const { ctx, outletIds } = await setup()
    const mgr = await manager(ctx, outletIds[0])
    await rejects(createItem(db, mgr, sheet), 'forbidden')
    const item = await createItem(db, ctx, sheet)
    await rejects(updateItem(db, mgr, item.id, { name: 'X' }), 'forbidden')
    await rejects(addPack(db, mgr, item.id, { name: 'B', baseQtyMilli: 1000, priceCents: 1, floorCents: 1 }), 'forbidden')
    await rejects(addBarcode(db, mgr, item.id, { barcode: '123', packId: null }), 'forbidden')
    // reads are open
    expect((await getItem(db, mgr, item.id)).id).toBe(item.id)
    expect(await listItems(db, mgr)).toHaveLength(1)
  })

  it('validates text fields', async () => {
    const { ctx, businessId } = await setup()
    await rejects(createItem(db, ctx, { ...sheet, name: '  ' }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, name: 'x'.repeat(201) }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, baseUnit: '' }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, baseUnit: 'x'.repeat(21) }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, sku: 'x'.repeat(65) }), 'invalid_input')
    const blankSku = await createItem(db, ctx, { ...sheet, sku: '   ' })
    expect(blankSku.sku).toBeNull()
    const sku = await createItem(db, ctx, { ...sheet, name: 'B', sku: ' SH-30 ' })
    expect(sku.sku).toBe('SH-30')
    expect(await auditCount(businessId, 'item.create')).toBe(2)
  })

  it('validates prices', async () => {
    const { ctx } = await setup()
    await rejects(
      createItem(db, ctx, { ...sheet, priceCents: 1000, floorCents: 1001 }),
      'invalid_input',
      "The lowest price can't be above the price.",
    )
    await rejects(createItem(db, ctx, { ...sheet, priceCents: -1, floorCents: 0 }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, priceCents: 10.5, floorCents: 0 }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, priceCents: 1000, floorCents: -1 }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, priceCents: 2 ** 40, floorCents: 0 }), 'invalid_input')
    expect((await createItem(db, ctx, { ...sheet, priceCents: 0, floorCents: 0 })).priceCents).toBe(0)
    expect((await createItem(db, ctx, { ...sheet, name: 'Eq', priceCents: 500, floorCents: 500 })).floorCents).toBe(500)
  })

  it('rejects a duplicate SKU in any case, but allows it in another business', async () => {
    const { ctx } = await setup()
    const other = await setup()
    await createItem(db, ctx, { ...sheet, sku: 'ABC-1' })
    await rejects(createItem(db, ctx, { ...sheet, name: 'B', sku: 'ABC-1' }), 'conflict', 'That SKU is already used.')
    await rejects(createItem(db, ctx, { ...sheet, name: 'B', sku: 'abc-1' }), 'conflict')
    await createItem(db, other.ctx, { ...sheet, sku: 'ABC-1' })
  })

  it('maps a concurrent same-SKU create to conflict', async () => {
    const { ctx, businessId } = await setup()
    const results = await Promise.allSettled([
      createItem(db, ctx, { ...sheet, sku: 'RACE' }),
      createItem(db, ctx, { ...sheet, name: 'B', sku: 'RACE' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as DomainError).code).toBe('conflict')
    expect(await auditCount(businessId, 'item.create')).toBe(1)
  })

  it('validates the low stock level against fractional', async () => {
    const { ctx } = await setup()
    await rejects(createItem(db, ctx, { ...sheet, lowStockMilli: 500 }), 'invalid_input')
    await rejects(createItem(db, ctx, { ...sheet, lowStockMilli: -1000 }), 'invalid_input')
    expect((await createItem(db, ctx, { ...sheet, lowStockMilli: 5000 })).lowStockMilli).toBe(5000)
    expect((await createItem(db, ctx, { ...mesh, lowStockMilli: 500 })).lowStockMilli).toBe(500)
    expect((await createItem(db, ctx, { ...sheet, name: 'Zero', lowStockMilli: 0 })).lowStockMilli).toBe(0)
  })

  it('checks references belong to the business', async () => {
    const { ctx, businessId } = await setup()
    const other = await setup()
    const fCat = await createCategory(db, other.ctx, { name: 'F', parentId: null })
    const fBrand = await createBrand(db, other.ctx, { name: 'F' })
    const fGroup = await createGroup(db, other.ctx, { name: 'F', attributeKeys: [] })
    await rejects(createItem(db, ctx, { ...sheet, categoryId: fCat.id }), 'not_found')
    await rejects(createItem(db, ctx, { ...sheet, brandId: fBrand.id }), 'not_found')
    await rejects(createItem(db, ctx, { ...sheet, groupId: fGroup.id }), 'not_found')
    await rejects(createItem(db, ctx, { ...sheet, groupId: 'nope' }), 'not_found')
    expect(await auditCount(businessId, 'item.create')).toBe(0)
  })

  it('checks attributes against the group keys', async () => {
    const { ctx } = await setup()
    const group = await createGroup(db, ctx, { name: 'Sheets', attributeKeys: ['size', 'gauge'] })
    const ok = await createItem(db, ctx, {
      ...sheet,
      groupId: group.id,
      attributes: { Size: ' 3m ', gauge: '30', color: '   ' },
    })
    expect(ok.attributes).toEqual({ size: '3m', gauge: '30' })
    await rejects(
      createItem(db, ctx, { ...sheet, name: 'B', groupId: group.id, attributes: { color: 'red' } }),
      'invalid_input',
    )
    await rejects(
      createItem(db, ctx, { ...sheet, name: 'B', attributes: { size: 'x'.repeat(51) } }),
      'invalid_input',
    )
    // an empty value for a key outside the group is dropped, not rejected
    const dropped = await createItem(db, ctx, { ...sheet, name: 'C', groupId: group.id, attributes: { color: '' } })
    expect(dropped.attributes).toEqual({})
  })

  it('stores category, brand and group', async () => {
    const { ctx } = await setup()
    const cat = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const brand = await createBrand(db, ctx, { name: 'Crown' })
    const group = await createGroup(db, ctx, { name: 'Sheets', attributeKeys: [] })
    const item = await createItem(db, ctx, {
      ...sheet,
      categoryId: cat.id,
      brandId: brand.id,
      groupId: group.id,
    })
    expect(item).toMatchObject({ categoryId: cat.id, brandId: brand.id, groupId: group.id })
  })
})

describe('updateItem', () => {
  beforeEach(resetDb)

  it('patches fields and audits before/after including the price', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, sheet)
    const u = await updateItem(db, ctx, item.id, { priceCents: 100000, floorCents: 95000, active: false })
    expect(u).toMatchObject({ name: sheet.name, priceCents: 100000, floorCents: 95000, active: false })
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'item.update')))
    expect(audit.entityId).toBe(item.id)
    expect(audit.data).toMatchObject({
      before: { priceCents: 95000, floorCents: 90000, active: true },
      after: { priceCents: 100000, floorCents: 95000, active: false },
    })
  })

  it('validates the merged result (floor against the existing price)', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, sheet)
    await rejects(updateItem(db, ctx, item.id, { floorCents: 95001 }), 'invalid_input')
    await rejects(updateItem(db, ctx, item.id, { priceCents: 89999 }), 'invalid_input')
    expect(await auditCount(businessId, 'item.update')).toBe(0)
    expect((await getItem(db, ctx, item.id)).priceCents).toBe(95000)
  })

  it('clears nullable fields and changes SKU, refusing a taken one', async () => {
    const { ctx } = await setup()
    const cat = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const a = await createItem(db, ctx, { ...sheet, categoryId: cat.id, sku: 'A', lowStockMilli: 3000 })
    await createItem(db, ctx, { ...sheet, name: 'B', sku: 'B' })
    const u = await updateItem(db, ctx, a.id, { categoryId: null, lowStockMilli: null, sku: 'A2' })
    expect(u).toMatchObject({ categoryId: null, lowStockMilli: null, sku: 'A2' })
    await rejects(updateItem(db, ctx, a.id, { sku: 'b' }), 'conflict', 'That SKU is already used.')
    expect((await updateItem(db, ctx, a.id, { sku: null })).sku).toBeNull()
    // re-saving the item's own SKU is fine
    expect((await updateItem(db, ctx, a.id, { sku: 'A2' })).sku).toBe('A2')
    expect((await updateItem(db, ctx, a.id, { sku: 'a2' })).sku).toBe('a2')
  })

  it('refuses a unit or fractional change once the item has stock history', async () => {
    const { ctx, businessId, outletIds } = await setup()
    const item = await createItem(db, ctx, sheet)
    // before any movement the unit can change
    expect((await updateItem(db, ctx, item.id, { baseUnit: 'pc' })).baseUnit).toBe('pc')
    await db.insert(stockMovements).values({
      businessId,
      outletId: outletIds[0],
      itemId: item.id,
      kind: 'receive',
      qtyMilli: 5000,
      actorUserId: ctx.userId,
    })
    const msg = "This item already has stock history; its unit can't change."
    await rejects(updateItem(db, ctx, item.id, { baseUnit: 'sheet' }), 'conflict', msg)
    await rejects(updateItem(db, ctx, item.id, { fractional: true }), 'conflict', msg)
    // unchanged values and other fields are fine
    expect(
      (await updateItem(db, ctx, item.id, { baseUnit: 'pc', fractional: false, name: 'Renamed' })).name,
    ).toBe('Renamed')
  })

  it('refuses making an item whole-unit while a pack holds a fraction', async () => {
    const { ctx } = await setup()
    const item = await createItem(db, ctx, mesh)
    await addPack(db, ctx, item.id, { name: 'Roll', baseQtyMilli: 2500, priceCents: 40000, floorCents: 30000 })
    await rejects(updateItem(db, ctx, item.id, { fractional: false }), 'invalid_input')
    await rejects(updateItem(db, ctx, item.id, { fractional: false, lowStockMilli: null }), 'invalid_input')
    expect((await getItem(db, ctx, item.id)).fractional).toBe(true)
  })

  it('rechecks attributes when the group changes', async () => {
    const { ctx } = await setup()
    const g1 = await createGroup(db, ctx, { name: 'G1', attributeKeys: ['size'] })
    const g2 = await createGroup(db, ctx, { name: 'G2', attributeKeys: ['colour'] })
    const item = await createItem(db, ctx, { ...sheet, groupId: g1.id, attributes: { size: '3m' } })
    await rejects(updateItem(db, ctx, item.id, { groupId: g2.id }), 'invalid_input')
    const moved = await updateItem(db, ctx, item.id, { groupId: g2.id, attributes: { colour: 'red' } })
    expect(moved).toMatchObject({ groupId: g2.id, attributes: { colour: 'red' } })
  })

  it('does not revalidate stored attributes when unrelated fields change', async () => {
    const { ctx } = await setup()
    const { updateGroup } = await import('@/server/services/taxonomy')
    const g = await createGroup(db, ctx, { name: 'G', attributeKeys: ['size'] })
    const item = await createItem(db, ctx, { ...sheet, groupId: g.id, attributes: { size: '3m' } })
    await updateGroup(db, ctx, g.id, { attributeKeys: ['colour'] })
    expect((await updateItem(db, ctx, item.id, { name: 'Renamed' })).attributes).toEqual({ size: '3m' })
  })

  it('returns not_found for another business or a malformed id, with no change', async () => {
    const { ctx, businessId } = await setup()
    const other = await setup()
    const item = await createItem(db, ctx, sheet)
    await rejects(updateItem(db, other.ctx, item.id, { name: 'Hacked' }), 'not_found')
    await rejects(updateItem(db, ctx, 'bad', { name: 'X' }), 'not_found')
    await rejects(getItem(db, other.ctx, item.id), 'not_found')
    await rejects(getItem(db, ctx, 'bad'), 'not_found')
    expect((await getItem(db, ctx, item.id)).name).toBe(sheet.name)
    expect(await auditCount(businessId, 'item.update')).toBe(0)
    expect(await auditCount(other.businessId, 'item.update')).toBe(0)
  })
})

describe('packs', () => {
  beforeEach(resetDb)

  it('adds a pack to an item', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, sheet)
    const pack = await addPack(db, ctx, item.id, {
      name: ' Bundle ',
      baseQtyMilli: 20000,
      priceCents: 1800000,
      floorCents: 1700000,
    })
    expect(pack).toMatchObject({
      name: 'Bundle',
      baseQtyMilli: 20000,
      priceCents: 1800000,
      floorCents: 1700000,
      active: true,
    })
    expect((await getItem(db, ctx, item.id)).packs).toEqual([pack])
    expect(await auditCount(businessId, 'pack.create')).toBe(1)
  })

  it('requires whole base quantities only for non-fractional items', async () => {
    const { ctx } = await setup()
    const item = await createItem(db, ctx, sheet)
    const p = { name: 'P', priceCents: 1000, floorCents: 900 }
    await rejects(addPack(db, ctx, item.id, { ...p, baseQtyMilli: 1500 }), 'invalid_input')
    await rejects(addPack(db, ctx, item.id, { ...p, baseQtyMilli: 0 }), 'invalid_input')
    await rejects(addPack(db, ctx, item.id, { ...p, baseQtyMilli: -1000 }), 'invalid_input')
    const wire = await createItem(db, ctx, mesh)
    const ok = await addPack(db, ctx, wire.id, { ...p, baseQtyMilli: 2500 })
    expect(ok.baseQtyMilli).toBe(2500)
  })

  it('validates name length, prices and unique names per item (any case)', async () => {
    const { ctx } = await setup()
    const item = await createItem(db, ctx, sheet)
    const other = await createItem(db, ctx, { ...sheet, name: 'Other' })
    const p = { baseQtyMilli: 10000, priceCents: 1000, floorCents: 900 }
    await rejects(addPack(db, ctx, item.id, { ...p, name: '' }), 'invalid_input')
    await rejects(addPack(db, ctx, item.id, { ...p, name: 'x'.repeat(41) }), 'invalid_input')
    await rejects(addPack(db, ctx, item.id, { ...p, name: 'P', floorCents: 1001 }), 'invalid_input')
    await addPack(db, ctx, item.id, { ...p, name: 'Bundle' })
    await rejects(addPack(db, ctx, item.id, { ...p, name: 'bundle' }), 'conflict')
    await addPack(db, ctx, other.id, { ...p, name: 'Bundle' })
  })

  it('returns not_found for another business item or a malformed id', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const item = await createItem(db, ctx, sheet)
    const p = { name: 'P', baseQtyMilli: 1000, priceCents: 10, floorCents: 10 }
    await rejects(addPack(db, other.ctx, item.id, p), 'not_found')
    await rejects(addPack(db, ctx, 'bad', p), 'not_found')
  })

  it('updates a pack with before/after audit, and checks the merged values', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, sheet)
    const a = await addPack(db, ctx, item.id, { name: 'A', baseQtyMilli: 10000, priceCents: 900000, floorCents: 800000 })
    await addPack(db, ctx, item.id, { name: 'B', baseQtyMilli: 20000, priceCents: 1800000, floorCents: 1700000 })
    const u = await updatePack(db, ctx, a.id, { name: 'A2', priceCents: 950000, active: false })
    expect(u).toMatchObject({ name: 'A2', priceCents: 950000, floorCents: 800000, active: false })
    await rejects(updatePack(db, ctx, a.id, { floorCents: 950001 }), 'invalid_input')
    await rejects(updatePack(db, ctx, a.id, { baseQtyMilli: 1500 }), 'invalid_input')
    await rejects(updatePack(db, ctx, a.id, { name: 'b' }), 'conflict')
    expect((await updatePack(db, ctx, a.id, { name: 'a2' })).name).toBe('a2')
    expect(await auditCount(businessId, 'pack.update')).toBe(2)
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'pack.update')))
      .limit(1)
    expect(audit.data).toMatchObject({ before: { name: 'A' }, after: { name: 'A2' } })
  })

  it('returns not_found for another business pack with no change', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const item = await createItem(db, ctx, sheet)
    const pack = await addPack(db, ctx, item.id, { name: 'A', baseQtyMilli: 1000, priceCents: 10, floorCents: 10 })
    await rejects(updatePack(db, other.ctx, pack.id, { name: 'Hacked' }), 'not_found')
    await rejects(updatePack(db, ctx, 'bad', { name: 'X' }), 'not_found')
    expect((await getItem(db, ctx, item.id)).packs[0].name).toBe('A')
  })
})

describe('barcodes', () => {
  beforeEach(resetDb)

  it('adds a barcode and removes it with audit rows', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, sheet)
    const bc = await addBarcode(db, ctx, item.id, { barcode: ' 6001234567890 ', packId: null })
    expect(bc).toMatchObject({ barcode: '6001234567890', packId: null })
    expect((await getItem(db, ctx, item.id)).barcodes).toEqual([bc])
    await removeBarcode(db, ctx, bc.id)
    expect((await getItem(db, ctx, item.id)).barcodes).toEqual([])
    expect(await db.select().from(itemBarcodes)).toHaveLength(0)
    expect(await auditCount(businessId, 'barcode.add')).toBe(1)
    expect(await auditCount(businessId, 'barcode.remove')).toBe(1)
    const [removed] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.businessId, businessId), eq(auditLog.action, 'barcode.remove')))
    expect(removed.data).toMatchObject({ itemId: item.id, barcode: '6001234567890' })
    await rejects(removeBarcode(db, ctx, bc.id), 'not_found')
  })

  it('validates the barcode format', async () => {
    const { ctx } = await setup()
    const item = await createItem(db, ctx, sheet)
    for (const bad of ['', '   ', 'has space', 'a_b', 'x'.repeat(65), 'café']) {
      await rejects(addBarcode(db, ctx, item.id, { barcode: bad, packId: null }), 'invalid_input')
    }
    for (const good of ['A-1.b', 'x'.repeat(64)]) {
      await addBarcode(db, ctx, item.id, { barcode: good, packId: null })
    }
  })

  it('is unique per business across items and packs', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const a = await createItem(db, ctx, sheet)
    const b = await createItem(db, ctx, { ...sheet, name: 'B' })
    const bPack = await addPack(db, ctx, b.id, { name: 'Bundle', baseQtyMilli: 5000, priceCents: 10, floorCents: 10 })
    const code = '6001234567890'
    await addBarcode(db, ctx, a.id, { barcode: code, packId: null })
    await rejects(addBarcode(db, ctx, b.id, { barcode: code, packId: null }), 'conflict', 'That barcode is already used.')
    await rejects(addBarcode(db, ctx, b.id, { barcode: code, packId: bPack.id }), 'conflict')
    await rejects(addBarcode(db, ctx, a.id, { barcode: ` ${code} `, packId: null }), 'conflict')
    const o = await createItem(db, other.ctx, sheet)
    await addBarcode(db, other.ctx, o.id, { barcode: code, packId: null })
  })

  it('maps a concurrent duplicate barcode to conflict', async () => {
    const { ctx, businessId } = await setup()
    const a = await createItem(db, ctx, sheet)
    const b = await createItem(db, ctx, { ...sheet, name: 'B' })
    const results = await Promise.allSettled([
      addBarcode(db, ctx, a.id, { barcode: 'RACE', packId: null }),
      addBarcode(db, ctx, b.id, { barcode: 'RACE', packId: null }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as DomainError).code).toBe('conflict')
    expect(await auditCount(businessId, 'barcode.add')).toBe(1)
  })

  it('requires the pack to belong to the item', async () => {
    const { ctx } = await setup()
    const a = await createItem(db, ctx, sheet)
    const b = await createItem(db, ctx, { ...sheet, name: 'B' })
    const bPack = await addPack(db, ctx, b.id, { name: 'Bundle', baseQtyMilli: 5000, priceCents: 10, floorCents: 10 })
    await rejects(addBarcode(db, ctx, a.id, { barcode: '111', packId: bPack.id }), 'not_found')
    await rejects(addBarcode(db, ctx, a.id, { barcode: '111', packId: 'bad' }), 'not_found')
    await rejects(addBarcode(db, ctx, a.id, { barcode: '111', packId: crypto.randomUUID() }), 'not_found')
    const ok = await addBarcode(db, ctx, b.id, { barcode: '111', packId: bPack.id })
    expect(ok.packId).toBe(bPack.id)
  })

  it('returns not_found for another business item or barcode', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const item = await createItem(db, ctx, sheet)
    const bc = await addBarcode(db, ctx, item.id, { barcode: '111', packId: null })
    await rejects(addBarcode(db, other.ctx, item.id, { barcode: '222', packId: null }), 'not_found')
    await rejects(addBarcode(db, ctx, 'bad', { barcode: '222', packId: null }), 'not_found')
    await rejects(removeBarcode(db, other.ctx, bc.id), 'not_found')
    await rejects(removeBarcode(db, ctx, 'bad'), 'not_found')
    expect((await getItem(db, ctx, item.id)).barcodes).toHaveLength(1)
  })

  it('refuses a manager to remove a barcode', async () => {
    const { ctx, outletIds } = await setup()
    const mgr = await manager(ctx, outletIds[0])
    const item = await createItem(db, ctx, sheet)
    const bc = await addBarcode(db, ctx, item.id, { barcode: '111', packId: null })
    await rejects(removeBarcode(db, mgr, bc.id), 'forbidden')
  })
})

describe('lookupBarcode', () => {
  beforeEach(resetDb)

  it('resolves base-unit and pack barcodes, and returns null otherwise', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const a = await createItem(db, ctx, sheet)
    const bundle = await addPack(db, ctx, a.id, {
      name: 'Bundle',
      baseQtyMilli: 20000,
      priceCents: 1800000,
      floorCents: 1700000,
    })
    await addBarcode(db, ctx, a.id, { barcode: '6001234567890', packId: null })
    await addBarcode(db, ctx, a.id, { barcode: '6001234567891', packId: bundle.id })

    const full = await getItem(db, ctx, a.id)
    expect(await lookupBarcode(db, ctx, '6001234567890')).toEqual({ item: full, pack: null })
    expect(await lookupBarcode(db, ctx, ' 6001234567891 ')).toEqual({ item: full, pack: bundle })
    expect(await lookupBarcode(db, ctx, '0000000000000')).toBeNull()
    expect(await lookupBarcode(db, ctx, '')).toBeNull()
    expect(await lookupBarcode(db, ctx, 'not valid!')).toBeNull()
    // another business cannot see it
    expect(await lookupBarcode(db, other.ctx, '6001234567890')).toBeNull()
  })

  it('returns null for a barcode on an inactive pack, and resolves it again once reactivated', async () => {
    const { ctx } = await setup()
    const a = await createItem(db, ctx, sheet)
    const bundle = await addPack(db, ctx, a.id, {
      name: 'Bundle',
      baseQtyMilli: 20000,
      priceCents: 1800000,
      floorCents: 1700000,
    })
    await addBarcode(db, ctx, a.id, { barcode: '222', packId: bundle.id })
    await updatePack(db, ctx, bundle.id, { active: false })
    expect(await lookupBarcode(db, ctx, '222')).toBeNull()
    await updatePack(db, ctx, bundle.id, { active: true })
    expect((await lookupBarcode(db, ctx, '222'))?.pack?.id).toBe(bundle.id)
  })

  it('returns null for an inactive item', async () => {
    const { ctx } = await setup()
    const a = await createItem(db, ctx, sheet)
    await addBarcode(db, ctx, a.id, { barcode: '111', packId: null })
    await updateItem(db, ctx, a.id, { active: false })
    expect(await lookupBarcode(db, ctx, '111')).toBeNull()
    await updateItem(db, ctx, a.id, { active: true })
    expect((await lookupBarcode(db, ctx, '111'))?.item.id).toBe(a.id)
  })
})

describe('listItems', () => {
  beforeEach(resetDb)

  it('orders by name and reports pack count and category name', async () => {
    const { ctx } = await setup()
    const cat = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const b = await createItem(db, ctx, { ...sheet, name: 'Beta', categoryId: cat.id })
    await createItem(db, ctx, { ...sheet, name: 'Alpha' })
    await addPack(db, ctx, b.id, { name: 'P1', baseQtyMilli: 5000, priceCents: 10, floorCents: 10 })
    const p2 = await addPack(db, ctx, b.id, { name: 'P2', baseQtyMilli: 6000, priceCents: 10, floorCents: 10 })
    await updatePack(db, ctx, p2.id, { active: false })
    const list = await listItems(db, ctx)
    expect(list.map((r) => r.name)).toEqual(['Alpha', 'Beta'])
    expect(list[0]).toMatchObject({ packCount: 0, categoryName: null, taxCategory: 'B', vatRateBp: 1600 })
    expect(list[1]).toMatchObject({ packCount: 1, categoryName: 'Roofing' })
    expect(list[1]).not.toHaveProperty('packs')
  })

  it('scopes to the business', async () => {
    const { ctx } = await setup()
    const other = await setup()
    await createItem(db, ctx, sheet)
    await createItem(db, other.ctx, { ...sheet, name: 'Theirs' })
    expect((await listItems(db, ctx)).map((r) => r.name)).toEqual([sheet.name])
  })

  it('searches the name (case-insensitive substring), SKU and exact barcode', async () => {
    const { ctx } = await setup()
    const a = await createItem(db, ctx, { ...sheet, name: 'Iron sheet', sku: 'SH-30' })
    const b = await createItem(db, ctx, { ...sheet, name: 'Nails 4in' })
    await addBarcode(db, ctx, b.id, { barcode: '6001234567890', packId: null })
    const names = async (search: string) => (await listItems(db, ctx, { search })).map((r) => r.name)
    expect(await names('IRON')).toEqual(['Iron sheet'])
    expect(await names('  sheet ')).toEqual(['Iron sheet'])
    expect(await names('sh-30')).toEqual(['Iron sheet'])
    expect(await names('SH-3')).toEqual([]) // SKU is an exact match
    expect(await names('6001234567890')).toEqual(['Nails 4in'])
    expect(await names('600123456789')).toEqual([]) // barcode is an exact match
    expect(await names('')).toEqual(['Iron sheet', 'Nails 4in'])
    expect(a.id).toBeDefined()
  })

  it('treats % and _ in search text literally', async () => {
    const { ctx } = await setup()
    await createItem(db, ctx, { ...sheet, name: '100% cotton' })
    await createItem(db, ctx, { ...sheet, name: 'Plain' })
    await createItem(db, ctx, { ...sheet, name: 'a_b' })
    await createItem(db, ctx, { ...sheet, name: 'axb' })
    const names = async (search: string) => (await listItems(db, ctx, { search })).map((r) => r.name)
    expect(await names('%')).toEqual(['100% cotton'])
    expect(await names('_')).toEqual(['a_b'])
    expect(await names('\\')).toEqual([])
  })

  it('does not find another business by barcode', async () => {
    const { ctx } = await setup()
    const other = await setup()
    const o = await createItem(db, other.ctx, sheet)
    await addBarcode(db, other.ctx, o.id, { barcode: '555', packId: null })
    expect(await listItems(db, ctx, { search: '555' })).toEqual([])
  })

  it('filters by active', async () => {
    const { ctx } = await setup()
    const a = await createItem(db, ctx, { ...sheet, name: 'A' })
    await createItem(db, ctx, { ...sheet, name: 'B' })
    await updateItem(db, ctx, a.id, { active: false })
    expect((await listItems(db, ctx, { active: true })).map((r) => r.name)).toEqual(['B'])
    expect((await listItems(db, ctx, { active: false })).map((r) => r.name)).toEqual(['A'])
    expect(await listItems(db, ctx)).toHaveLength(2)
  })

  it('a top-level category filter includes items in its children', async () => {
    const { ctx } = await setup()
    const roofing = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const sheets = await createCategory(db, ctx, { name: 'Sheets', parentId: roofing.id })
    const paint = await createCategory(db, ctx, { name: 'Paint', parentId: null })
    await createItem(db, ctx, { ...sheet, name: 'Top item', categoryId: roofing.id })
    await createItem(db, ctx, { ...sheet, name: 'Child item', categoryId: sheets.id })
    await createItem(db, ctx, { ...sheet, name: 'Paint item', categoryId: paint.id })
    await createItem(db, ctx, { ...sheet, name: 'Uncategorised' })
    const names = async (categoryId: string) =>
      (await listItems(db, ctx, { categoryId })).map((r) => r.name)
    expect(await names(roofing.id)).toEqual(['Child item', 'Top item'])
    expect(await names(sheets.id)).toEqual(['Child item'])
    expect(await names(paint.id)).toEqual(['Paint item'])
    expect(await names('bad')).toEqual([])
    expect(await names(crypto.randomUUID())).toEqual([])
  })
})

describe('audit', () => {
  beforeEach(resetDb)

  it('leaves exactly one audit row per write and none for failures', async () => {
    const { ctx, businessId } = await setup()
    const item = await createItem(db, ctx, sheet)
    await updateItem(db, ctx, item.id, { name: 'Renamed' })
    const pack = await addPack(db, ctx, item.id, { name: 'P', baseQtyMilli: 5000, priceCents: 10, floorCents: 10 })
    await updatePack(db, ctx, pack.id, { priceCents: 20 })
    const bc = await addBarcode(db, ctx, item.id, { barcode: '111', packId: pack.id })
    await removeBarcode(db, ctx, bc.id)
    // failures leave nothing behind
    await rejects(addBarcode(db, ctx, item.id, { barcode: 'bad code', packId: null }), 'invalid_input')
    await rejects(addPack(db, ctx, item.id, { name: 'P', baseQtyMilli: 5000, priceCents: 10, floorCents: 10 }), 'conflict')
    for (const action of [
      'item.create',
      'item.update',
      'pack.create',
      'pack.update',
      'barcode.add',
      'barcode.remove',
    ]) {
      expect(await auditCount(businessId, action)).toBe(1)
    }
  })
})

describe('reusable validators and tx inserts', () => {
  beforeEach(resetDb)

  it('validators are pure and normalize', () => {
    expect(normalizeBarcode(' 123-A.b ')).toBe('123-A.b')
    expect(() => normalizeBarcode('a b')).toThrow(DomainError)
    expect(validateItemInput({ ...sheet, taxCategory: 'C', sku: ' x ' })).toMatchObject({
      taxCategory: 'C',
      sku: 'x',
      groupId: null,
      attributes: {},
    })
    expect(() => validateItemInput({ ...sheet, floorCents: sheet.priceCents + 1 })).toThrow(DomainError)
    expect(validatePackInput({ name: 'P', baseQtyMilli: 2500, priceCents: 5, floorCents: 5 }, true).baseQtyMilli).toBe(2500)
    expect(() =>
      validatePackInput({ name: 'P', baseQtyMilli: 2500, priceCents: 5, floorCents: 5 }, false),
    ).toThrow(DomainError)
  })

  it('compose inside one transaction, and roll back together', async () => {
    const { ctx, businessId } = await setup()
    const made = await db.transaction(async (tx) => {
      const item = await insertItemTx(tx, ctx, validateItemInput({ ...sheet, sku: 'IMP-1' }))
      const pack = await insertPackTx(
        tx,
        ctx,
        item.id,
        validatePackInput({ name: 'Bundle', baseQtyMilli: 10000, priceCents: 900000, floorCents: 800000 }, false),
      )
      await insertBarcodeTx(tx, ctx, item.id, { barcode: normalizeBarcode('IMP-BC'), packId: pack.id })
      return item
    })
    expect((await getItem(db, ctx, made.id)).packs).toHaveLength(1)
    expect((await lookupBarcode(db, ctx, 'IMP-BC'))?.pack?.name).toBe('Bundle')

    await expect(
      db.transaction(async (tx) => {
        await insertItemTx(tx, ctx, validateItemInput({ ...sheet, name: 'Rolled back', sku: 'IMP-2' }))
        await insertItemTx(tx, ctx, validateItemInput({ ...sheet, name: 'Dup', sku: 'IMP-1' }))
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await db.select().from(items).where(eq(items.sku, 'IMP-2'))).toHaveLength(0)
    expect(await auditCount(businessId, 'item.create')).toBe(1)
  })
})
