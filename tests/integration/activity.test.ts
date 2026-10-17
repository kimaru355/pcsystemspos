import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema'
import { IMPORT_COLUMNS } from '@/domain/catalog-import'
import { toCsv } from '@/domain/csv'
import { listRecentActivity } from '@/server/services/activity'
import { applyImport } from '@/server/services/catalog-import'
import { createBrand } from '@/server/services/taxonomy'
import { getTenantCtx } from '@/server/tenant'
import { resetDb, seedBusiness } from '../helpers/db'

const none = { outletIds: [], membershipIds: [] }

async function setup() {
  const seeded = await seedBusiness({ outletCodes: ['KTL'] })
  const ctx = (await getTenantCtx(db, seeded.owner.userId))!
  return { ...seeded, ctx }
}

describe('listRecentActivity', () => {
  beforeEach(resetDb)

  it('orders rows written in the same instant by insertion, newest first', async () => {
    const { ctx, businessId } = await setup()
    const at = new Date('2026-10-17T07:00:00Z')
    const rows = Array.from({ length: 5 }, (_, i) => ({
      businessId,
      actorUserId: ctx.userId,
      action: 'brand.create',
      entityType: 'brand',
      entityId: `b${i}`,
      createdAt: at,
    }))
    // Insert in two statements so the sequence, not the row order, is what the feed can rely on.
    await db.insert(auditLog).values(rows.slice(0, 3))
    await db.insert(auditLog).values(rows.slice(3))
    const feed = await listRecentActivity(db, ctx, none, 10)
    expect(feed.map((e) => e.entityId)).toEqual(['b4', 'b3', 'b2', 'b1', 'b0'])
  })

  it('shows an import as one catalog.import row, not its per-entity rows', async () => {
    const { ctx } = await setup()
    await createBrand(db, ctx, { name: 'Hand made' })
    const cols = [...IMPORT_COLUMNS, 'stock_KTL']
    const rows: Record<string, string>[] = [
      { name: 'Iron sheet', category: 'Roofing', brand: 'Mabati', sku: 'IS-1', barcode: '6001', base_unit: 'sheet', price: '950', stock_KTL: '5' },
      { name: 'Nails', group: 'Fasteners', base_unit: 'kg', price: '200' },
    ]
    await applyImport(db, ctx, toCsv([cols, ...rows.map((r) => cols.map((c) => r[c] ?? ''))]))

    const all = await db.select().from(auditLog)
    expect(all.length).toBeGreaterThan(6)
    const feed = await listRecentActivity(db, ctx, none, 50)
    expect(feed.map((e) => e.action).sort()).toEqual(['brand.create', 'catalog.import'])
    const summary = feed.find((e) => e.action === 'catalog.import')!
    expect(summary.data).toMatchObject({ itemCount: 2, packCount: 0, stockCells: 1 })
  })
})
