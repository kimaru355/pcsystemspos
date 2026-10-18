import { randomUUID } from 'node:crypto'
import { db } from '@/db/client'
import { formatOrderNumber } from '@/domain/order-state'
import type { Op } from '@/domain/sync-ops'
import { authenticateDevice, registerDevice, type DeviceAuth } from '@/server/services/devices'
import { createItem, addPack } from '@/server/services/items'
import { createStaff, setPin } from '@/server/services/staff'
import { receiveStock } from '@/server/services/stock'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'
import { seedBusiness } from '../helpers/db'

export const uuid = () => randomUUID()

/** A business with one outlet (KTL), a till there, a cashier and a manager with PINs, and stocked items. */
export async function tillWorld() {
  const seeded = await seedBusiness({ outletCodes: ['KTL', 'ELD'] })
  const owner = (await getTenantCtx(db, seeded.owner.userId))!
  const [ktl, eld] = seeded.outletIds
  const cement = await createItem(db, owner, {
    name: 'Cement 50kg',
    baseUnit: 'bag',
    fractional: false,
    priceCents: 78000,
    floorCents: 75000,
    lowStockMilli: 5000,
  })
  const sheet = await createItem(db, owner, {
    name: 'Iron sheet 30G',
    baseUnit: 'sheet',
    fractional: false,
    priceCents: 95000,
    floorCents: 90000,
    lowStockMilli: null,
  })
  const bundle = await addPack(db, owner, sheet.id, {
    name: 'Bundle',
    baseQtyMilli: 20000,
    priceCents: 1800000,
    floorCents: 1750000,
  })
  await receiveStock(db, owner, { outletId: ktl, itemId: cement.id, qtyMilli: 100000 })
  await receiveStock(db, owner, { outletId: ktl, itemId: sheet.id, qtyMilli: 100000 })
  const reg = await registerDevice(db, owner, { outletId: ktl, name: 'Front counter' })
  const auth = await authenticateDevice(db, reg.token)
  if (!auth.ok) throw new Error('device auth failed')
  const cashier = await hire(owner, 'cashier', [ktl], '1111')
  const manager = await hire(owner, 'manager', [ktl], '2222')
  return { ...seeded, owner, ktl, eld, cement, sheet, bundle, token: reg.token, device: auth.device, cashier, manager }
}

export type TillWorld = Awaited<ReturnType<typeof tillWorld>>

let hired = 0
export async function hire(owner: TenantCtx, role: 'cashier' | 'manager', outletIds: string[], pin: string) {
  hired += 1
  const m = await createStaff(db, owner, {
    name: `${role} ${hired}`,
    email: `${role}${hired}-${randomUUID().slice(0, 8)}@till.test`,
    role,
    outletIds,
    tempPassword: 'temp-pass-1234',
  })
  await setPin(db, owner, m.membershipId, pin)
  return { ...m, ctx: (await getTenantCtx(db, m.userId))! }
}

let seq = 0
export function nextNumber(device: DeviceAuth) {
  seq += 1
  return { number: formatOrderNumber(device.outletCode, device.code, seq), seq }
}

const at = () => new Date().toISOString()

export function checkoutOp(
  w: TillWorld,
  o: {
    actorId?: string
    lines?: Extract<Op, { type: 'sale.checkout' }>['payload']['order']['lines']
    cashCents?: number
    collect?: 'all' | 'none' | { lineId: string; qtyMilli: number }[]
    creditApproverId?: string | null
    customer?: { name: string; phone: string } | null
    orderId?: string
  } = {},
): Extract<Op, { type: 'sale.checkout' }> {
  const lines = o.lines ?? [
    {
      id: uuid(),
      itemId: w.cement.id,
      packId: null,
      qtyMilli: 2000,
      unitPriceCents: 78000,
      listPriceCents: 78000,
      floorCents: 75000,
      priceApproverId: null,
    },
  ]
  const collect = o.collect ?? 'all'
  const { number, seq } = nextNumber(w.device)
  return {
    id: uuid(),
    type: 'sale.checkout',
    actorId: o.actorId ?? w.cashier.membershipId,
    occurredAt: at(),
    payload: {
      order: { id: o.orderId ?? uuid(), number, seq, customer: o.customer ?? null, lines },
      payments: o.cashCents
        ? [{ id: uuid(), method: 'cash', amountCents: o.cashCents, reason: null, approverId: null }]
        : [],
      collection:
        collect === 'none'
          ? null
          : {
              id: uuid(),
              lines: collect === 'all' ? lines.map((l) => ({ lineId: l.id, qtyMilli: l.qtyMilli })) : collect,
              creditApproverId: o.creditApproverId ?? null,
            },
    },
  }
}

export function paymentOp(w: TillWorld, orderId: string, amountCents: number, actorId = w.cashier.membershipId): Op {
  return {
    id: uuid(),
    type: 'payment.add',
    actorId,
    occurredAt: at(),
    payload: {
      orderId,
      payment: { id: uuid(), method: 'cash', amountCents, reason: null, approverId: null },
      customer: null,
    },
  }
}

export function collectionOp(
  w: TillWorld,
  orderId: string,
  lines: { lineId: string; qtyMilli: number }[],
  creditApproverId: string | null = null,
): Op {
  return {
    id: uuid(),
    type: 'collection.record',
    actorId: w.cashier.membershipId,
    occurredAt: at(),
    payload: { orderId, collection: { id: uuid(), lines, creditApproverId }, customer: null },
  }
}

export function adjustOp(w: TillWorld, deltaMilli: number, actorId = w.manager.membershipId): Op {
  return {
    id: uuid(),
    type: 'stock.adjust',
    actorId,
    occurredAt: at(),
    payload: { movementId: uuid(), itemId: w.cement.id, deltaMilli, reason: 'damaged', note: null },
  }
}

export const CLOCK = { jumps: 0, lastJumpAt: null }
