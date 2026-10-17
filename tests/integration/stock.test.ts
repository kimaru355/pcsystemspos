import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, items, outletStock, outlets, stockMovements } from '@/db/schema'
import { DomainError } from '@/server/errors'
import { createItem, updateItem, type ItemInput } from '@/server/services/items'
import {
  adjustStock,
  applyMovement,
  countStock,
  itemHistory,
  itemStockByOutlet,
  listStock,
  lowStockCounts,
  owedMilliFor,
  receiveStock,
} from '@/server/services/stock'
import { createStaff } from '@/server/services/staff'
import { createCategory } from '@/server/services/taxonomy'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

const sheet: ItemInput = {
  name: 'Iron sheet 30G 3m',
  baseUnit: 'sheet',
  fractional: false,
  priceCents: 95000,
  floorCents: 90000,
  lowStockMilli: 10000,
}

async function setup() {
  const seeded = await seedBusiness({ outletCodes: ['KTL', 'ELD'] })
  const ctx = (await getTenantCtx(db, seeded.owner.userId))!
  const [ktl, eld] = seeded.outletIds
  const item = await createItem(db, ctx, sheet)
  return { ...seeded, ctx, ktl, eld, item }
}

async function hire(ctx: TenantCtx, role: 'manager' | 'cashier', outletIds: string[]): Promise<TenantCtx> {
  const m = await createStaff(db, ctx, {
    name: `${role} person`,
    email: `${role}-${Math.random().toString(36).slice(2)}@staff.test`,
    role,
    outletIds,
    tempPassword: 'temp-pass-1234',
  })
  return (await getTenantCtx(db, m.userId))!
}

async function expectDomain(p: Promise<unknown>, code: DomainError['code'], message?: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(DomainError)
  expect((err as DomainError).code).toBe(code)
  if (message) expect((err as DomainError).message).toBe(message)
}

async function movementCount(itemId: string): Promise<number> {
  return (await db.select().from(stockMovements).where(eq(stockMovements.itemId, itemId))).length
}

async function onHand(outletId: string, itemId: string): Promise<number | undefined> {
  const [r] = await db
    .select()
    .from(outletStock)
    .where(and(eq(outletStock.outletId, outletId), eq(outletStock.itemId, itemId)))
  return r?.onHandMilli
}

describe('receiveStock', () => {
  beforeEach(resetDb)

  it('receives into an outlet, records the movement and names the actor', async () => {
    const { ctx, ktl, item, businessId } = await setup()
    const m = await receiveStock(db, ctx, {
      outletId: ktl,
      itemId: item.id,
      qtyMilli: 25000,
      unitCostCents: 80000,
      note: '  first delivery ',
    })
    expect(m).toMatchObject({
      outletId: ktl,
      itemId: item.id,
      kind: 'receive',
      qtyMilli: 25000,
      unitCostCents: 80000,
      reason: null,
      note: 'first delivery',
      actorUserId: ctx.userId,
      actorName: expect.stringContaining('Owner'),
    })
    expect(m.occurredAt).toBeInstanceOf(Date)
    expect(await onHand(ktl, item.id)).toBe(25000)
    const rows = await db.select().from(stockMovements).where(eq(stockMovements.itemId, item.id))
    expect(rows).toMatchObject([{ businessId, kind: 'receive', qtyMilli: 25000 }])
  })

  it('rejects a non-positive quantity, a bad cost and an over-long note', async () => {
    const { ctx, ktl, item } = await setup()
    const base = { outletId: ktl, itemId: item.id }
    await expectDomain(receiveStock(db, ctx, { ...base, qtyMilli: 0 }), 'invalid_input')
    await expectDomain(receiveStock(db, ctx, { ...base, qtyMilli: -1000 }), 'invalid_input')
    await expectDomain(receiveStock(db, ctx, { ...base, qtyMilli: 1.5 }), 'invalid_input')
    await expectDomain(receiveStock(db, ctx, { ...base, qtyMilli: 1000, unitCostCents: -1 }), 'invalid_input')
    await expectDomain(receiveStock(db, ctx, { ...base, qtyMilli: 1000, unitCostCents: 1.5 }), 'invalid_input')
    await expectDomain(receiveStock(db, ctx, { ...base, qtyMilli: 1000, note: 'x'.repeat(201) }), 'invalid_input')
    expect(await movementCount(item.id)).toBe(0)
  })

  it('refuses a fractional quantity for a non-fractional item (Review Focus 4)', async () => {
    const { ctx, ktl, item } = await setup()
    await expectDomain(receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 2500 }), 'invalid_input')
    expect(await movementCount(item.id)).toBe(0)
  })

  it('accepts a fractional quantity for a fractional item', async () => {
    const { ctx, ktl } = await setup()
    const cable = await createItem(db, ctx, { ...sheet, name: 'Cable', baseUnit: 'm', fractional: true, lowStockMilli: null })
    const m = await receiveStock(db, ctx, { outletId: ktl, itemId: cable.id, qtyMilli: 2500 })
    expect(m.qtyMilli).toBe(2500)
  })

  it('treats a malformed or foreign outlet or item as not_found', async () => {
    const { ctx, ktl, item } = await setup()
    const other = await seedBusiness({ outletCodes: ['ZZZ'] })
    const otherCtx = (await getTenantCtx(db, other.owner.userId))!
    const otherItem = await createItem(db, otherCtx, { ...sheet, name: 'Theirs' })
    await expectDomain(receiveStock(db, ctx, { outletId: 'nope', itemId: item.id, qtyMilli: 1000 }), 'not_found')
    await expectDomain(receiveStock(db, ctx, { outletId: ktl, itemId: 'nope', qtyMilli: 1000 }), 'not_found')
    await expectDomain(
      receiveStock(db, ctx, { outletId: other.outletIds[0], itemId: item.id, qtyMilli: 1000 }),
      'not_found',
    )
    await expectDomain(receiveStock(db, ctx, { outletId: ktl, itemId: otherItem.id, qtyMilli: 1000 }), 'not_found')
    expect(await movementCount(otherItem.id)).toBe(0)
  })

  it('refuses an inactive outlet or inactive item with invalid_input', async () => {
    const { ctx, ktl, eld, item } = await setup()
    await db.update(outlets).set({ active: false }).where(eq(outlets.id, eld))
    await expectDomain(receiveStock(db, ctx, { outletId: eld, itemId: item.id, qtyMilli: 1000 }), 'invalid_input')
    await expectDomain(adjustStock(db, ctx, { outletId: eld, itemId: item.id, deltaMilli: 1000, reason: 'damaged' }), 'invalid_input')
    await expectDomain(countStock(db, ctx, { outletId: eld, itemId: item.id, countedMilli: 1000 }), 'invalid_input')
    await updateItem(db, ctx, item.id, { active: false })
    await expectDomain(receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 1000 }), 'invalid_input')
    await expectDomain(adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: 1000, reason: 'damaged' }), 'invalid_input')
    await expectDomain(countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: 1000 }), 'invalid_input')
  })

  it('enforces roles and outlet scope (Review Focus 5)', async () => {
    const { ctx, ktl, eld, item } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const cashier = await hire(ctx, 'cashier', [ktl])
    const other = await seedBusiness({ outletCodes: ['ZZZ'] })

    expect((await receiveStock(db, mgr, { outletId: ktl, itemId: item.id, qtyMilli: 1000 })).qtyMilli).toBe(1000)
    await expectDomain(receiveStock(db, mgr, { outletId: eld, itemId: item.id, qtyMilli: 1000 }), 'forbidden')
    await expectDomain(receiveStock(db, mgr, { outletId: other.outletIds[0], itemId: item.id, qtyMilli: 1000 }), 'not_found')
    await expectDomain(receiveStock(db, cashier, { outletId: ktl, itemId: item.id, qtyMilli: 1000 }), 'forbidden')
    await expectDomain(
      adjustStock(db, cashier, { outletId: ktl, itemId: item.id, deltaMilli: -1000, reason: 'damaged' }),
      'forbidden',
    )
    await expectDomain(countStock(db, cashier, { outletId: ktl, itemId: item.id, countedMilli: 0 }), 'forbidden')
    await expectDomain(adjustStock(db, mgr, { outletId: eld, itemId: item.id, deltaMilli: 1000, reason: 'damaged' }), 'forbidden')
    expect(await onHand(ktl, item.id)).toBe(1000)
    expect(await onHand(eld, item.id)).toBeUndefined()
  })
})

describe('adjustStock and countStock', () => {
  beforeEach(resetDb)

  it('counts to a quantity, then returns null when the count matches', async () => {
    const { ctx, ktl, item, businessId } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 25000 })

    const m = await countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: 8000 })
    expect(m).toMatchObject({ kind: 'adjust', qtyMilli: -17000, reason: 'count_correction' })
    expect(await onHand(ktl, item.id)).toBe(8000)
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'stock.adjust'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      businessId,
      actorUserId: ctx.userId,
      entityId: m!.id,
      data: { outletId: ktl, itemId: item.id, deltaMilli: -17000, reason: 'count_correction' },
    })

    const before = await movementCount(item.id)
    expect(await countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: 8000 })).toBeNull()
    expect(await movementCount(item.id)).toBe(before)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'stock.adjust'))).toHaveLength(1)
  })

  it('counts an item that has never been stocked', async () => {
    const { ctx, ktl, item } = await setup()
    expect(await countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: 0 })).toBeNull()
    const m = await countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: 3000 })
    expect(m).toMatchObject({ qtyMilli: 3000, reason: 'count_correction' })
    expect(await onHand(ktl, item.id)).toBe(3000)
  })

  it('rejects a negative or fractional count', async () => {
    const { ctx, ktl, item } = await setup()
    await expectDomain(countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: -1000 }), 'invalid_input')
    await expectDomain(countStock(db, ctx, { outletId: ktl, itemId: item.id, countedMilli: 1500 }), 'invalid_input')
    expect(await movementCount(item.id)).toBe(0)
  })

  it('refuses an adjustment that would go below zero and writes nothing', async () => {
    const { ctx, ktl, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 8000 })
    await expectDomain(
      adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: -9000, reason: 'lost_stolen' }),
      'invalid_input',
      'That would take stock below zero.',
    )
    expect(await onHand(ktl, item.id)).toBe(8000)
    expect(await movementCount(item.id)).toBe(1)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'stock.adjust'))).toHaveLength(0)
  })

  it('allows an adjustment that raises negative stock without reaching zero, and still refuses a drop', async () => {
    const { ctx, ktl, item, businessId } = await setup()
    await db.transaction((tx) =>
      applyMovement(tx, {
        businessId,
        outletId: ktl,
        itemId: item.id,
        kind: 'collect',
        qtyMilli: -5000,
        actorUserId: ctx.userId,
      }),
    )
    const m = await adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: 2000, reason: 'damaged' })
    expect(m.qtyMilli).toBe(2000)
    expect(await onHand(ktl, item.id)).toBe(-3000)
    await expectDomain(
      adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: -1000, reason: 'lost_stolen' }),
      'invalid_input',
      'That would take stock below zero.',
    )
    expect(await onHand(ktl, item.id)).toBe(-3000)
  })

  it('records the item name and unit on the adjustment audit row', async () => {
    const { ctx, ktl, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 8000 })
    await adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: -1000, reason: 'damaged' })
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, 'stock.adjust'))
    expect(row.data).toMatchObject({ itemName: 'Iron sheet 30G 3m', baseUnit: 'sheet', deltaMilli: -1000, reason: 'damaged' })
  })

  it('applies a valid adjustment with an audit row', async () => {
    const { ctx, ktl, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 8000 })
    const m = await adjustStock(db, ctx, {
      outletId: ktl,
      itemId: item.id,
      deltaMilli: -1000,
      reason: 'damaged',
      note: 'dropped',
    })
    expect(m).toMatchObject({ kind: 'adjust', qtyMilli: -1000, reason: 'damaged', note: 'dropped' })
    expect(await onHand(ktl, item.id)).toBe(7000)
    const [a] = await db.select().from(auditLog).where(eq(auditLog.action, 'stock.adjust'))
    expect(a.data).toEqual({
      outletId: ktl,
      itemId: item.id,
      itemName: item.name,
      baseUnit: item.baseUnit,
      deltaMilli: -1000,
      reason: 'damaged',
    })
  })

  it('requires a note for reason other, and validates delta, reason and note length', async () => {
    const { ctx, ktl, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 8000 })
    const base = { outletId: ktl, itemId: item.id }
    await expectDomain(adjustStock(db, ctx, { ...base, deltaMilli: -1000, reason: 'other' }), 'invalid_input')
    await expectDomain(adjustStock(db, ctx, { ...base, deltaMilli: -1000, reason: 'other', note: '   ' }), 'invalid_input')
    await expectDomain(adjustStock(db, ctx, { ...base, deltaMilli: 0, reason: 'damaged' }), 'invalid_input')
    await expectDomain(adjustStock(db, ctx, { ...base, deltaMilli: -1500, reason: 'damaged' }), 'invalid_input')
    await expectDomain(
      adjustStock(db, ctx, { ...base, deltaMilli: -1000, reason: 'bogus' as unknown as 'damaged' }),
      'invalid_input',
    )
    await expectDomain(
      adjustStock(db, ctx, { ...base, deltaMilli: -1000, reason: 'damaged', note: 'x'.repeat(201) }),
      'invalid_input',
    )
    const ok = await adjustStock(db, ctx, { ...base, deltaMilli: -1000, reason: 'other', note: 'rusted' })
    expect(ok.note).toBe('rusted')
    expect(await onHand(ktl, item.id)).toBe(7000)
  })
})

describe('listStock', () => {
  beforeEach(resetDb)

  it('includes unstocked active items at 0, ordered by name, and flags low stock', async () => {
    const { ctx, ktl, eld, item } = await setup()
    const nails = await createItem(db, ctx, { ...sheet, name: 'Aaa nails', baseUnit: 'kg', fractional: true, lowStockMilli: null })
    const retired = await createItem(db, ctx, { ...sheet, name: 'Retired' })
    await updateItem(db, ctx, retired.id, { active: false })
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 10000 })

    const rows = await listStock(db, ctx, ktl)
    expect(rows.map((r) => r.itemName)).toEqual(['Aaa nails', 'Iron sheet 30G 3m'])
    expect(rows[0]).toMatchObject({
      itemId: nails.id,
      baseUnit: 'kg',
      fractional: true,
      onHandMilli: 0,
      owedMilli: 0,
      availableMilli: 0,
      lowStockMilli: null,
      isLow: false,
      negative: false,
    })
    expect(rows[1]).toMatchObject({ itemId: item.id, onHandMilli: 10000, availableMilli: 10000, lowStockMilli: 10000, isLow: true })

    const low = await listStock(db, ctx, ktl, { lowOnly: true })
    expect(low.map((r) => r.itemId)).toEqual([item.id])
    // Stock is per outlet: nothing received at ELD, so it is 0 on hand (and low against the level of 10000).
    const eldRows = await listStock(db, ctx, eld)
    expect(eldRows.find((r) => r.itemId === item.id)).toMatchObject({ onHandMilli: 0, isLow: true })
  })

  it('shows negative stock and filters by negativeOnly, search and category', async () => {
    const { ctx, ktl, item, businessId } = await setup()
    const cat = await createCategory(db, ctx, { name: 'Roofing', parentId: null })
    const nails = await createItem(db, ctx, { ...sheet, name: 'Nails', categoryId: cat.id, lowStockMilli: null })
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 8000 })
    await db.transaction((tx) =>
      applyMovement(tx, {
        businessId,
        outletId: ktl,
        itemId: nails.id,
        kind: 'collect',
        qtyMilli: -1000,
        actorUserId: ctx.userId,
      }),
    )

    const neg = await listStock(db, ctx, ktl, { negativeOnly: true })
    expect(neg).toMatchObject([{ itemId: nails.id, onHandMilli: -1000, negative: true }])
    expect((await listStock(db, ctx, ktl, { search: 'iron' })).map((r) => r.itemId)).toEqual([item.id])
    expect((await listStock(db, ctx, ktl, { search: '%' })).length).toBe(0)
    expect((await listStock(db, ctx, ktl, { categoryId: cat.id })).map((r) => r.itemId)).toEqual([nails.id])
    expect(await listStock(db, ctx, ktl, { categoryId: 'nope' })).toEqual([])
  })

  it('needs an outlet in scope', async () => {
    const { ctx, ktl, eld } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    const cashier = await hire(ctx, 'cashier', [ktl])
    expect(await listStock(db, mgr, ktl)).toHaveLength(1)
    expect(await listStock(db, cashier, ktl)).toHaveLength(1)
    await expectDomain(listStock(db, mgr, eld), 'forbidden')
    await expectDomain(listStock(db, ctx, 'nope'), 'not_found')
    const other = await seedBusiness({ outletCodes: ['ZZZ'] })
    await expectDomain(listStock(db, ctx, other.outletIds[0]), 'not_found')
  })
})

describe('owedMilliFor', () => {
  beforeEach(resetDb)
  it('is 0 for every item in this phase', async () => {
    const { ktl, item } = await setup()
    const owed = await owedMilliFor(db, ktl, [item.id])
    expect(owed.get(item.id)).toBe(0)
    expect((await owedMilliFor(db, ktl, [])).size).toBe(0)
  })
})

describe('lowStockCounts', () => {
  beforeEach(resetDb)

  it('counts low items per active outlet in scope', async () => {
    const { ctx, ktl, eld, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 5000 })
    await receiveStock(db, ctx, { outletId: eld, itemId: item.id, qtyMilli: 50000 })
    expect(await lowStockCounts(db, ctx)).toEqual([{ outletId: ktl, count: 1 }])

    const mgr = await hire(ctx, 'manager', [eld])
    expect(await lowStockCounts(db, mgr)).toEqual([])
    await db.update(outlets).set({ active: false }).where(eq(outlets.id, ktl))
    expect(await lowStockCounts(db, ctx)).toEqual([])
  })
})

describe('itemStockByOutlet', () => {
  beforeEach(resetDb)

  it('lists on-hand per active outlet in scope, zero where nothing was received', async () => {
    const { ctx, ktl, eld, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 5000 })
    const rows = await itemStockByOutlet(db, ctx, item.id)
    expect(rows.map((r) => [r.outletCode, r.onHandMilli, r.isLow])).toEqual([
      ['ELD', 0, true],
      ['KTL', 5000, true],
    ])
    await receiveStock(db, ctx, { outletId: eld, itemId: item.id, qtyMilli: 50000 })
    expect((await itemStockByOutlet(db, ctx, item.id)).map((r) => r.isLow)).toEqual([false, true])

    const mgr = await hire(ctx, 'manager', [ktl])
    expect((await itemStockByOutlet(db, mgr, item.id)).map((r) => r.outletCode)).toEqual(['KTL'])
    await db.update(outlets).set({ active: false }).where(eq(outlets.id, ktl))
    expect((await itemStockByOutlet(db, ctx, item.id)).map((r) => r.outletCode)).toEqual(['ELD'])
  })

  it('is not_found for an unknown, malformed or other-business item', async () => {
    const { ctx, item } = await setup()
    const other = await seedBusiness({ outletCodes: ['OTH'] })
    const otherCtx = (await getTenantCtx(db, other.owner.userId))!
    await expectDomain(itemStockByOutlet(db, ctx, 'nope'), 'not_found')
    await expectDomain(itemStockByOutlet(db, otherCtx, item.id), 'not_found')
  })
})

describe('itemHistory', () => {
  beforeEach(resetDb)

  it('lists movements newest first and honours the limit', async () => {
    const { ctx, ktl, item } = await setup()
    const a = await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 5000 })
    const b = await adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: -1000, reason: 'damaged' })
    const c = await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 2000 })
    const h = await itemHistory(db, ctx, ktl, item.id)
    expect(h.map((m) => m.id)).toEqual([c.id, b.id, a.id])
    expect(h[0].actorName).toContain('Owner')
    expect((await itemHistory(db, ctx, ktl, item.id, 2)).map((m) => m.id)).toEqual([c.id, b.id])
  })

  it('checks access like the other reads', async () => {
    const { ctx, ktl, eld, item } = await setup()
    const mgr = await hire(ctx, 'manager', [ktl])
    await expectDomain(itemHistory(db, mgr, eld, item.id), 'forbidden')
    await expectDomain(itemHistory(db, ctx, ktl, 'nope'), 'not_found')
    await expectDomain(itemHistory(db, ctx, 'nope', item.id), 'not_found')
    expect(await itemHistory(db, mgr, ktl, item.id)).toEqual([])
  })
})

describe('applyMovement', () => {
  beforeEach(resetDb)

  it('goes negative with a flag, then clears the flag once back at or above zero', async () => {
    const { ctx, ktl, item, businessId } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 8000 })
    const collect = await db.transaction((tx) =>
      applyMovement(tx, {
        businessId,
        outletId: ktl,
        itemId: item.id,
        kind: 'collect',
        qtyMilli: -30000,
        actorUserId: ctx.userId,
      }),
    )
    expect(collect.onHandMilli).toBe(-22000)
    const [flagged] = await db.select().from(outletStock).where(eq(outletStock.itemId, item.id))
    expect(flagged.onHandMilli).toBe(-22000)
    expect(flagged.flaggedNegativeAt).toBeInstanceOf(Date)

    // Still negative keeps the original flag time.
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 1000 })
    const [still] = await db.select().from(outletStock).where(eq(outletStock.itemId, item.id))
    expect(still.flaggedNegativeAt).toEqual(flagged.flaggedNegativeAt)

    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 29000 })
    const [cleared] = await db.select().from(outletStock).where(eq(outletStock.itemId, item.id))
    expect(cleared.onHandMilli).toBe(8000)
    expect(cleared.flaggedNegativeAt).toBeNull()
  })

  it('refuses an item of another business and rolls back with the caller', async () => {
    const { ctx, ktl, item, businessId } = await setup()
    const other = await seedBusiness({ outletCodes: ['ZZZ'] })
    await expectDomain(
      db.transaction((tx) =>
        applyMovement(tx, {
          businessId: other.businessId,
          outletId: other.outletIds[0],
          itemId: item.id,
          kind: 'receive',
          qtyMilli: 1000,
          actorUserId: other.owner.userId,
        }),
      ),
      'not_found',
    )
    await expectDomain(
      db.transaction(async (tx) => {
        await applyMovement(tx, {
          businessId,
          outletId: ktl,
          itemId: item.id,
          kind: 'receive',
          qtyMilli: 1000,
          actorUserId: ctx.userId,
        })
        throw new DomainError('conflict')
      }),
      'conflict',
    )
    expect(await movementCount(item.id)).toBe(0)
    expect(await onHand(ktl, item.id)).toBeUndefined()
  })
})

describe('concurrency (Review Focus 1)', () => {
  beforeEach(resetDb)

  it('keeps on-hand equal to the ledger sum under concurrent receives and adjusts', async () => {
    const { ctx, ktl, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 5000 })
    const calls: Promise<unknown>[] = []
    for (let i = 0; i < 10; i++) calls.push(receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 1000 }))
    for (let i = 0; i < 5; i++) {
      calls.push(adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: -1000, reason: 'damaged' }))
    }
    await Promise.all(calls)

    const [sum] = (await db.execute<{ total: string }>(sqlSum(ktl, item.id))).rows
    expect(Number(sum.total)).toBe(10000)
    expect(await onHand(ktl, item.id)).toBe(10000)
  })

  it('never lets concurrent adjustments take stock below zero', async () => {
    const { ctx, ktl, item } = await setup()
    await receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 3000 })
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        adjustStock(db, ctx, { outletId: ktl, itemId: item.id, deltaMilli: -1000, reason: 'damaged' }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as DomainError).code).toBe('invalid_input')
    }
    expect(await onHand(ktl, item.id)).toBe(0)
  })

  it('waits for a concurrent item update (items row is locked FOR SHARE)', async () => {
    const { ctx, ktl, item } = await setup()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => (locked = r))
    const updater = db.transaction(async (tx) => {
      await tx.select().from(items).where(eq(items.id, item.id)).for('update')
      locked()
      await held
    })
    await lockTaken
    let done = false
    const receive = receiveStock(db, ctx, { outletId: ktl, itemId: item.id, qtyMilli: 1000 }).then(
      (m) => {
        done = true
        return m
      },
    )
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(done).toBe(false)
    } finally {
      release()
      await updater
    }
    expect((await receive).qtyMilli).toBe(1000)
  })
})

function sqlSum(outletId: string, itemId: string) {
  return sql`select coalesce(sum(qty_milli), 0)::text as total from stock_movements where outlet_id = ${outletId} and item_id = ${itemId}`
}
