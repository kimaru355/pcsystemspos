import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import {
  categories,
  itemBarcodes,
  itemPacks,
  items,
  outlets,
  stockMovements,
  users,
} from '@/db/schema'
import { resetDb, seedBusiness } from '../helpers/db'

/** Drizzle wraps driver errors; the Postgres error is on `cause`. */
async function pgCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } }
    return err.cause?.code ?? err.code
  }
  return undefined
}

async function newItem(businessId: string, over: Partial<typeof items.$inferInsert> = {}) {
  const [row] = await db
    .insert(items)
    .values({
      businessId,
      name: 'Item',
      baseUnit: 'pc',
      priceCents: 10000,
      floorCents: 8000,
      ...over,
    })
    .returning({ id: items.id })
  return row.id
}

describe('catalog schema constraints', () => {
  beforeEach(resetDb)

  describe('categories', () => {
    it('rejects two top-level categories with the same name in one business', async () => {
      const { businessId } = await seedBusiness()
      await db.insert(categories).values({ businessId, name: 'Roofing' })
      const code = await pgCode(db.insert(categories).values({ businessId, name: 'Roofing' }))
      expect(code).toBe('23505')
    })

    it('allows the same name under two different parents', async () => {
      const { businessId } = await seedBusiness()
      const [a] = await db.insert(categories).values({ businessId, name: 'A' }).returning()
      const [b] = await db.insert(categories).values({ businessId, name: 'B' }).returning()
      await db.insert(categories).values({ businessId, parentId: a.id, name: 'Roofing' })
      const code = await pgCode(
        db.insert(categories).values({ businessId, parentId: b.id, name: 'Roofing' }),
      )
      expect(code).toBeUndefined()
    })
  })

  describe('items', () => {
    it('rejects the same sku twice in one business', async () => {
      const { businessId } = await seedBusiness()
      await newItem(businessId, { sku: 'IS-30' })
      expect(await pgCode(newItem(businessId, { sku: 'IS-30' }))).toBe('23505')
    })

    it('allows two items with a null sku', async () => {
      const { businessId } = await seedBusiness()
      await newItem(businessId)
      expect(await pgCode(newItem(businessId))).toBeUndefined()
    })

    it('allows the same sku in another business', async () => {
      const a = await seedBusiness()
      const b = await seedBusiness()
      await newItem(a.businessId, { sku: 'IS-30' })
      expect(await pgCode(newItem(b.businessId, { sku: 'IS-30' }))).toBeUndefined()
    })

    it('rejects a floor above the price', async () => {
      const { businessId } = await seedBusiness()
      expect(await pgCode(newItem(businessId, { priceCents: 100, floorCents: 101 }))).toBe('23514')
    })

    it('rejects a negative low-stock level and accepts null or 0', async () => {
      const { businessId } = await seedBusiness()
      expect(await pgCode(newItem(businessId, { lowStockMilli: -1 }))).toBe('23514')
      expect(await pgCode(newItem(businessId, { lowStockMilli: 0 }))).toBeUndefined()
      expect(await pgCode(newItem(businessId, { lowStockMilli: null }))).toBeUndefined()
    })
  })

  describe('item_packs', () => {
    it('rejects a pack with zero base quantity', async () => {
      const { businessId } = await seedBusiness()
      const itemId = await newItem(businessId)
      const code = await pgCode(
        db.insert(itemPacks).values({
          businessId,
          itemId,
          name: 'Box',
          baseQtyMilli: 0,
          priceCents: 100,
          floorCents: 50,
        }),
      )
      expect(code).toBe('23514')
    })
  })

  describe('item_barcodes', () => {
    it('rejects a pack_id that belongs to a different item', async () => {
      const { businessId } = await seedBusiness()
      const itemA = await newItem(businessId, { name: 'A' })
      const itemB = await newItem(businessId, { name: 'B' })
      const [pack] = await db
        .insert(itemPacks)
        .values({
          businessId,
          itemId: itemB,
          name: 'Box',
          baseQtyMilli: 12000,
          priceCents: 100,
          floorCents: 50,
        })
        .returning({ id: itemPacks.id })
      const code = await pgCode(
        db
          .insert(itemBarcodes)
          .values({ businessId, itemId: itemA, packId: pack.id, barcode: '6001' }),
      )
      expect(code).toBe('23503')
    })

    it('rejects the same barcode twice in one business', async () => {
      const { businessId } = await seedBusiness()
      const itemId = await newItem(businessId)
      await db.insert(itemBarcodes).values({ businessId, itemId, barcode: '6001' })
      const code = await pgCode(
        db.insert(itemBarcodes).values({ businessId, itemId, barcode: '6001' }),
      )
      expect(code).toBe('23505')
    })

    it('allows the same barcode in another business', async () => {
      const a = await seedBusiness()
      const b = await seedBusiness()
      const itemA = await newItem(a.businessId)
      const itemB = await newItem(b.businessId)
      await db.insert(itemBarcodes).values({ businessId: a.businessId, itemId: itemA, barcode: '6001' })
      const code = await pgCode(
        db.insert(itemBarcodes).values({ businessId: b.businessId, itemId: itemB, barcode: '6001' }),
      )
      expect(code).toBeUndefined()
    })
  })

  describe('stock_movements', () => {
    async function base() {
      const seeded = await seedBusiness({ outletCodes: ['KTL'] })
      const itemId = await newItem(seeded.businessId)
      return {
        businessId: seeded.businessId,
        outletId: seeded.outletIds[0],
        itemId,
        actorUserId: seeded.owner.userId,
      }
    }

    it('accepts a valid receive', async () => {
      const b = await base()
      const code = await pgCode(
        db.insert(stockMovements).values({ ...b, kind: 'receive', qtyMilli: 5000 }),
      )
      expect(code).toBeUndefined()
    })

    it('rejects a negative unit cost and accepts null or 0', async () => {
      const b = await base()
      const insert = (unitCostCents: number | null) =>
        pgCode(db.insert(stockMovements).values({ ...b, kind: 'receive', qtyMilli: 1000, unitCostCents }))
      expect(await insert(-1)).toBe('23514')
      expect(await insert(0)).toBeUndefined()
      expect(await insert(null)).toBeUndefined()
    })

    it('rejects a receive with negative quantity', async () => {
      const b = await base()
      const code = await pgCode(
        db.insert(stockMovements).values({ ...b, kind: 'receive', qtyMilli: -1000 }),
      )
      expect(code).toBe('23514')
    })

    it('rejects an adjust without a reason', async () => {
      const b = await base()
      const code = await pgCode(
        db.insert(stockMovements).values({ ...b, kind: 'adjust', qtyMilli: -1000 }),
      )
      expect(code).toBe('23514')
    })

    it('rejects reason other without a note', async () => {
      const b = await base()
      const code = await pgCode(
        db
          .insert(stockMovements)
          .values({ ...b, kind: 'adjust', qtyMilli: -1000, reason: 'other' }),
      )
      expect(code).toBe('23514')
    })
  })

  describe('phase 1 follow-ups', () => {
    it('rejects two users whose emails differ only in case', async () => {
      await db.insert(users).values({ name: 'A', email: 'Bob@Example.com', passwordHash: 'x' })
      const code = await pgCode(
        db.insert(users).values({ name: 'B', email: 'bob@example.com', passwordHash: 'x' }),
      )
      expect(code).toBe('23505')
    })

    it('rejects an outlet code that is not 2-5 uppercase alphanumerics', async () => {
      const { businessId } = await seedBusiness()
      const code = await pgCode(db.insert(outlets).values({ businessId, name: 'Bad', code: 'k1' }))
      expect(code).toBe('23514')
    })
  })
})
