import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import {
  devices,
  memberships,
  orderLines,
  orders,
  payments,
  stockMovements,
} from '@/db/schema'
import { createItem } from '@/server/services/items'
import { receiveStock } from '@/server/services/stock'
import { getTenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(
    () => undefined,
    (e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code,
  )
}

async function setup() {
  const seeded = await seedBusiness({ outletCodes: ['KTL'] })
  const ctx = (await getTenantCtx(db, seeded.owner.userId))!
  const item = await createItem(db, ctx, {
    name: 'Cement 50kg',
    baseUnit: 'bag',
    fractional: false,
    priceCents: 78000,
    floorCents: 75000,
    lowStockMilli: null,
  })
  const [device] = await db
    .insert(devices)
    .values({
      businessId: seeded.businessId,
      outletId: seeded.outletIds[0],
      code: '01',
      name: 'Counter',
      tokenHash: randomUUID(),
      registeredBy: seeded.owner.userId,
    })
    .returning()
  return { ...seeded, ctx, item, device }
}

async function insertOrder(s: Awaited<ReturnType<typeof setup>>) {
  const orderId = randomUUID()
  await db.insert(orders).values({
    id: orderId,
    businessId: s.businessId,
    outletId: s.outletIds[0],
    deviceId: s.device.id,
    number: `KTL-01-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
    seq: 1,
    createdBy: s.owner.userId,
    occurredAt: new Date(),
  })
  return orderId
}

describe('phase 3-5 schema', () => {
  beforeEach(resetDb)

  it('keeps the stock ledger append-only', async () => {
    const s = await setup()
    const m = await receiveStock(db, s.ctx, { outletId: s.outletIds[0], itemId: s.item.id, qtyMilli: 5000 })
    expect(
      await pgCode(db.update(stockMovements).set({ note: 'x' }).where(eq(stockMovements.id, m.id))),
    ).toBe('23001')
    expect(await pgCode(db.delete(stockMovements).where(eq(stockMovements.id, m.id)))).toBe('23001')
  })

  it('allows one active membership per person, any number of inactive ones', async () => {
    const a = await seedBusiness()
    const b = await seedBusiness()
    // A second active membership for A's owner, in B: refused.
    expect(
      await pgCode(db.insert(memberships).values({ businessId: b.businessId, userId: a.owner.userId, role: 'cashier' })),
    ).toBe('23505')
    await db.update(memberships).set({ active: false }).where(eq(memberships.id, a.owner.membershipId))
    await db.insert(memberships).values({ businessId: b.businessId, userId: a.owner.userId, role: 'cashier' })
    const rows = await db.select().from(memberships).where(eq(memberships.userId, a.owner.userId))
    expect(rows).toHaveLength(2)
  })

  it('checks device codes and keeps them unique per outlet', async () => {
    const s = await setup()
    const base = {
      businessId: s.businessId,
      outletId: s.outletIds[0],
      name: 'X',
      registeredBy: s.owner.userId,
    }
    expect(await pgCode(db.insert(devices).values({ ...base, code: '1', tokenHash: randomUUID() }))).toBe('23514')
    expect(await pgCode(db.insert(devices).values({ ...base, code: '01', tokenHash: randomUUID() }))).toBe('23505')
  })

  it('refuses a device tied to another business outlet', async () => {
    const s = await setup()
    const other = await seedBusiness({ outletCodes: ['ELD'] })
    expect(
      await pgCode(
        db.insert(devices).values({
          businessId: s.businessId,
          outletId: other.outletIds[0],
          code: '02',
          name: 'X',
          tokenHash: randomUUID(),
          registeredBy: s.owner.userId,
        }),
      ),
    ).toBe('23503')
  })

  it('keeps collected + cancelled within the ordered quantity', async () => {
    const s = await setup()
    const orderId = await insertOrder(s)
    const line = {
      orderId,
      businessId: s.businessId,
      itemId: s.item.id,
      position: 0,
      name: 'Cement',
      unitLabel: 'bag',
      baseQtyPerUnitMilli: 1000,
      unitPriceCents: 78000,
      listPriceCents: 78000,
      floorCents: 75000,
      taxCategory: 'B' as const,
      vatRateBp: 1600,
    }
    expect(
      await pgCode(
        db.insert(orderLines).values({ ...line, id: randomUUID(), qtyMilli: 2000, collectedMilli: 1500, cancelledMilli: 1000 }),
      ),
    ).toBe('23514')
    await db.insert(orderLines).values({ ...line, id: randomUUID(), qtyMilli: 2000, collectedMilli: 1000, cancelledMilli: 1000 })
  })

  it('requires an approver and reason for mark-paid', async () => {
    const s = await setup()
    const orderId = await insertOrder(s)
    const p = {
      orderId,
      businessId: s.businessId,
      amountCents: 1000,
      actorUserId: s.owner.userId,
      occurredAt: new Date(),
    }
    expect(await pgCode(db.insert(payments).values({ ...p, id: randomUUID(), method: 'mark_paid' }))).toBe('23514')
    await db.insert(payments).values({
      ...p,
      id: randomUUID(),
      method: 'mark_paid',
      reason: 'Paid to the boss',
      approvedBy: s.owner.userId,
    })
    expect(await pgCode(db.insert(payments).values({ ...p, id: randomUUID(), method: 'cash', amountCents: 0 }))).toBe(
      '23514',
    )
  })

  it('serves the activity feed ordering from the audit index', async () => {
    const { rows } = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'audit_log_business_created_seq_idx'`,
    )
    expect(rows[0].indexdef).toContain('DESC')
    expect(rows[0].indexdef).not.toContain('NULLS LAST')
  })
})
