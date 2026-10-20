import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkout, takePayment, type Actor } from '@/client/till/actions'
import { TillDb } from '@/client/till/db'
import { TillEngine } from '@/client/till/engine'
import { buildView } from '@/client/till/view'
import type { Op } from '@/domain/sync-ops'
import type { CatalogSection, SyncResponse, TillSettings } from '@/domain/till-data'

const ITEM = '11111111-1111-4111-8111-111111111111'
const CASHIER = '22222222-2222-4222-8222-222222222222'
const actor: Actor = { membershipId: CASHIER, name: 'Jane', role: 'cashier' }

const settings: TillSettings = {
  businessName: 'Acme',
  outlet: { id: 'o1', code: 'KTL', name: 'Kitale', active: true },
  device: { id: 'd1', code: '03', name: 'Counter' },
  mode: 'default',
  lastOrderSeq: 7,
  mpesa: false,
}

const catalog: CatalogSection = {
  items: [
    {
      id: ITEM,
      name: 'Cement',
      sku: 'CEM',
      baseUnit: 'bag',
      fractional: false,
      priceCents: 78000,
      floorCents: 75000,
      taxCategory: 'B',
      lowStockMilli: null,
      categoryId: null,
      groupId: null,
      attributes: {},
    },
  ],
  packs: [],
  barcodes: [],
  categories: [],
  groups: [],
}

function response(over: Partial<SyncResponse> = {}): SyncResponse {
  return {
    results: [],
    serverTime: new Date(Date.UTC(2026, 9, 18, 8)).toISOString(),
    settings,
    sections: {
      catalog: { hash: 'c1', data: catalog },
      stock: { hash: 's1', data: { onHand: [{ itemId: ITEM, onHandMilli: 10000 }] } },
      staff: { hash: 'st1', data: { staff: [] } },
      orders: { hash: 'o1', data: { orders: [] } },
    },
    ...over,
  }
}

let db: TillDb
let engine: TillEngine
let fetchMock: ReturnType<typeof vi.fn>
let wall = Date.UTC(2026, 9, 18, 8)
let mono = 0

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }))
}

async function view() {
  const sections = Object.fromEntries((await db.sections.toArray()).map((s) => [s.name, s.data]))
  return buildView(sections, (await db.getKv('settings')) ?? null, await db.outbox.orderBy('seq').toArray())
}

beforeEach(async () => {
  db = new TillDb(`test-${Math.random()}`)
  wall = Date.UTC(2026, 9, 18, 8)
  mono = 0
  engine = new TillEngine(db, () => wall, () => mono)
  fetchMock = vi.fn(() => reply(200, response()))
  vi.stubGlobal('fetch', fetchMock)
  await db.setKv('device', { token: 'tok', deviceId: 'd1', code: '03' })
})

afterEach(async () => {
  engine.stop()
  vi.unstubAllGlobals()
  await db.delete()
})

describe('till engine', () => {
  it('first sync stores sections, settings, sequence and anchors the clock', async () => {
    await engine.syncNow()
    expect((await db.getKv('sync'))?.lastError).toBe(null)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sync')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toMatchObject({ ops: [], hashes: {} })
    expect((await db.sections.toArray()).map((s) => s.name).sort()).toEqual(['catalog', 'orders', 'staff', 'stock'])
    expect(await db.getKv('orderSeq')).toBe(7)
    expect((await db.getKv('sync'))?.lastSyncAt).toBe(Date.UTC(2026, 9, 18, 8))
    expect(await engine.nextOrderSeq()).toBe(8)
  })

  it('sends the hashes it holds, and keeps sections the server did not resend', async () => {
    await engine.syncNow()
    fetchMock.mockImplementation(() => reply(200, response({ sections: {} })))
    await engine.syncNow()
    const body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)
    expect(body.hashes).toEqual({ catalog: 'c1', stock: 's1', staff: 'st1', orders: 'o1' })
    expect(await db.sections.count()).toBe(4)
  })

  it('a sale made offline waits in the outbox, shows in the view, and leaves once acknowledged', async () => {
    await engine.syncNow()
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')))
    const r = await checkout(engine, await view(), actor, {
      cart: [{ id: crypto.randomUUID(), itemId: ITEM, packId: null, qtyMilli: 2000, unitPriceCents: 78000, priceApproverId: null }],
      customer: { name: '', phone: '' },
      payment: { method: 'cash', amountCents: 156000, reason: '', approverId: null },
      collect: {},
      creditApproverId: null,
    })
    expect(r.ok).toBe(false) // nothing collected and no customer: refused, no number used
    expect(await db.getKv('orderSeq')).toBe(7)

    const v0 = await view()
    const cart = [{ id: crypto.randomUUID(), itemId: ITEM, packId: null, qtyMilli: 2000, unitPriceCents: 78000, priceApproverId: null }]
    const ok = await checkout(engine, v0, actor, {
      cart,
      customer: { name: '', phone: '' },
      payment: { method: 'cash', amountCents: 156000, reason: '', approverId: null },
      collect: { [cart[0].id]: 2000 },
      creditApproverId: null,
    })
    expect(ok.ok && ok.order.number).toBe('KTL-03-000008')
    await engine.syncNow().catch(() => {})
    expect(await db.outbox.count()).toBe(1)
    const v1 = await view()
    expect(v1.orders[0]).toMatchObject({ number: 'KTL-03-000008', status: 'closed' })
    expect(v1.orders[0].events[0].pending).toBe(true)
    expect(v1.onHand.get(ITEM)).toBe(8000)
    expect((await db.getKv('sync'))?.lastError).toBe('No connection to the server.')

    // Back online: the server applies it and returns the order in its section.
    const [queued] = await db.outbox.toArray()
    fetchMock.mockImplementation(() =>
      reply(200, response({ results: [{ id: queued.op.id, status: 'applied' }] })),
    )
    await engine.syncNow()
    expect(await db.outbox.count()).toBe(0)
  })

  it('keeps a refused op for display and stops on a revoked device', async () => {
    await engine.syncNow()
    const op: Op = {
      id: crypto.randomUUID(),
      type: 'stock.adjust',
      actorId: CASHIER,
      occurredAt: new Date(wall).toISOString(),
      payload: { movementId: crypto.randomUUID(), itemId: ITEM, deltaMilli: -1000, reason: 'damaged', note: null },
    }
    fetchMock.mockImplementation(() =>
      reply(200, response({ results: [{ id: op.id, status: 'rejected', code: 'forbidden', message: 'No' }] })),
    )
    await engine.enqueue(op, { actorName: 'Jane' })
    await engine.syncNow()
    expect(await db.outbox.count()).toBe(0)
    expect((await db.rejected.get(op.id))?.message).toBe('No')

    fetchMock.mockImplementation(() => reply(401, { error: 'revoked', message: 'This till was revoked.' }))
    await engine.syncNow()
    expect((await db.getKv('sync'))?.refused).toBe('revoked')
    const calls = fetchMock.mock.calls.length
    await engine.syncNow()
    expect(fetchMock.mock.calls.length).toBe(calls) // no more calls once refused
  })

  it('a payment taken offline updates the order in the view', async () => {
    const orderId = crypto.randomUUID()
    const lineId = crypto.randomUUID()
    fetchMock.mockImplementation(() =>
      reply(
        200,
        response({
          sections: {
            ...response().sections,
            orders: {
              hash: 'o2',
              data: {
                orders: [
                  {
                    id: orderId,
                    number: 'KTL-03-000001',
                    outletId: 'o1',
                    status: 'open',
                    customer: { name: 'Peter', phone: '+254712345678' },
                    lines: [
                      {
                        lineId,
                        itemId: ITEM,
                        packId: null,
                        name: 'Cement',
                        unitLabel: 'bag',
                        baseQtyPerUnitMilli: 1000,
                        qtyMilli: 2000,
                        collectedMilli: 0,
                        cancelledMilli: 0,
                        unitPriceCents: 78000,
                        listPriceCents: 78000,
                        floorCents: 75000,
                        taxCategory: 'B',
                        vatRateBp: 1600,
                        position: 0,
                      },
                    ],
                    paidCents: 0,
                    creditCents: 0,
                    flagged: false,
                    occurredAt: new Date(wall).toISOString(),
                    events: [],
                  },
                ],
              },
            },
          },
        }),
      ),
    )
    await engine.syncNow()
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('offline')))
    const v = await view()
    expect(v.owed.get(ITEM)).toBe(2000)
    const r = await takePayment(engine, v, actor, v.orders[0], { method: 'cash', amountCents: 50000, reason: '', approverId: null }, {
      name: '',
      phone: '',
    })
    expect(r.ok).toBe(true)
    await engine.syncNow().catch(() => {})
    expect((await view()).orders[0].paidCents).toBe(50000)
  })

  it('counts a clock turned back and reports it at the next sync', async () => {
    await engine.start()
    await engine.syncNow()
    wall -= 24 * 3600_000
    mono += 15_000
    await engine.tickClock()
    expect(engine.clockState()?.pendingJumps).toBe(1)
    await engine.syncNow()
    const body = JSON.parse((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body as string)
    expect(body.clock.jumps).toBe(1)
    expect(engine.clockState()?.pendingJumps).toBe(0)
  })
})
