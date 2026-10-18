import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import {
  categories,
  devices,
  itemBarcodes,
  itemGroups,
  itemPacks,
  items,
  outletStock,
  syncOps,
} from '@/db/schema'
import { isUuid } from '@/domain/ids'
import { can } from '@/domain/permissions'
import { opSchema, syncRequestSchema, type Op, type OpResult, type Section, type StockAdjust } from '@/domain/sync-ops'
import type { CatalogSection, SectionData, StockSection, SyncResponse, TillSettings } from '@/domain/till-data'
import { DomainError } from '@/server/errors'
import { recordAudit } from './audit'
import type { DeviceAuth } from './devices'
import { applyCollectionRecord, applyPaymentAdd, applySaleCheckout, ordersForTill, type OpContext } from './orders'
import { insertMovementTx, lockStockTx } from './stock'
import { isAllowedAtOutlet, membersById, staffForDevice } from './till-auth'

/*
 * The till's single sync endpoint.
 *
 * Push: each op runs in its own transaction that first inserts its `sync_ops` row (primary key
 * = the op's client id). A repeated id finds the stored row and returns its result without
 * applying anything: exactly once. A DomainError, or a constraint violation caused by the op's
 * data, rolls back to a savepoint and stores the op as rejected (payload kept, so nothing the
 * till recorded is lost); any other error fails the request and the till retries.
 *
 * Pull: four sections, each sent only when its content hash differs from the one the till has.
 */

const MAX_FUTURE_MS = 0

type Handler = (tx: Tx, c: OpContext, op: Op) => Promise<void>

const HANDLERS: { [T in Op['type']]: Handler } = {
  'sale.checkout': (tx, c, op) => applySaleCheckout(tx, c, (op as Extract<Op, { type: 'sale.checkout' }>).payload),
  'payment.add': (tx, c, op) => applyPaymentAdd(tx, c, (op as Extract<Op, { type: 'payment.add' }>).payload),
  'collection.record': (tx, c, op) =>
    applyCollectionRecord(tx, c, (op as Extract<Op, { type: 'collection.record' }>).payload),
  'stock.adjust': (tx, c, op) => applyStockAdjust(tx, c, (op as Extract<Op, { type: 'stock.adjust' }>).payload),
}

/** A Postgres integrity-constraint violation (class 23) anywhere in a wrapped error. */
function integrityViolation(e: unknown): string | null {
  for (let err = e as { code?: unknown; cause?: unknown } | undefined, i = 0; err && i < 3; i++) {
    if (typeof err.code === 'string' && err.code.startsWith('23')) return err.code
    err = err.cause as typeof err
  }
  return null
}

/** Till stock adjustment: like the admin's, except it may take on-hand below zero (flagged). */
async function applyStockAdjust(tx: Tx, c: OpContext, p: StockAdjust): Promise<void> {
  if (!can(c.actor.role, 'stock.adjust')) throw new DomainError('forbidden', 'Only an owner or manager can adjust stock.')
  if (!(await isAllowedAtOutlet(tx, c.actor.membershipId, c.actor.role, c.device.outletId))) {
    throw new DomainError('forbidden', 'That person is not assigned to this outlet.')
  }
  const note = p.note?.trim() || null
  if (p.reason === 'other' && note === null) throw new DomainError('invalid_input', 'Add a note when the reason is Other.')
  const locked = await lockStockTx(tx, c.device.businessId, c.device.outletId, p.itemId)
  if (!locked.fractional && p.deltaMilli % 1000 !== 0) {
    throw new DomainError('invalid_input', 'This item is only counted in whole units.')
  }
  const { movementId } = await insertMovementTx(tx, locked, {
    id: p.movementId,
    businessId: c.device.businessId,
    outletId: c.device.outletId,
    itemId: p.itemId,
    kind: 'adjust',
    qtyMilli: p.deltaMilli,
    reason: p.reason,
    note,
    actorUserId: c.actor.userId,
    occurredAt: c.occurredAt,
    deviceId: c.device.deviceId,
  })
  await recordAudit(tx, {
    businessId: c.device.businessId,
    actorUserId: c.actor.userId,
    action: 'stock.adjust',
    entityType: 'stock_movement',
    entityId: movementId,
    data: {
      outletId: c.device.outletId,
      itemId: p.itemId,
      itemName: locked.itemName,
      baseUnit: locked.baseUnit,
      deltaMilli: p.deltaMilli,
      reason: p.reason,
    },
    deviceId: c.device.deviceId,
    occurredAt: c.occurredAt,
    opId: c.opId,
  })
}

function rawId(raw: unknown): string | null {
  const id = (raw as { id?: unknown } | null)?.id
  return typeof id === 'string' && isUuid(id) ? id : null
}

/** Store an op as rejected (or return the earlier result when its id was seen before). */
async function storeRejected(
  db: Db,
  device: DeviceAuth,
  id: string,
  raw: unknown,
  code: string,
  message: string,
): Promise<OpResult> {
  const r = raw as { type?: unknown } | null
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(syncOps)
      .values({
        id,
        businessId: device.businessId,
        deviceId: device.deviceId,
        type: typeof r?.type === 'string' ? r.type.slice(0, 50) : 'unknown',
        payload: raw ?? {},
        occurredAt: new Date(),
        status: 'rejected',
        errorCode: code,
        errorMessage: message,
      })
      .onConflictDoNothing()
      .returning({ id: syncOps.id })
    if (inserted.length > 0) return { id, status: 'rejected', code, message }
    return earlierResult(tx, device, id)
  })
}

async function earlierResult(tx: Tx, device: DeviceAuth, id: string): Promise<OpResult> {
  const [prev] = await tx.select().from(syncOps).where(eq(syncOps.id, id))
  // Another business's op id: never reveal its result.
  if (!prev || prev.businessId !== device.businessId) {
    return { id, status: 'rejected', code: 'conflict', message: 'That operation id is already used.' }
  }
  return prev.status === 'applied'
    ? { id, status: 'applied' }
    : { id, status: 'rejected', code: prev.errorCode ?? 'invalid_input', message: prev.errorMessage ?? '' }
}

/** Apply one raw op exactly once. */
export async function applyOp(db: Db, device: DeviceAuth, raw: unknown, now = new Date()): Promise<OpResult> {
  const id = rawId(raw)
  const parsed = opSchema.safeParse(raw)
  if (!parsed.success) {
    const message = 'The till sent an operation the server cannot read.'
    if (id === null) return { id: String((raw as { id?: unknown } | null)?.id ?? ''), status: 'rejected', code: 'invalid_input', message }
    return storeRejected(db, device, id, raw, 'invalid_input', message)
  }
  const op = parsed.data
  const occurred = new Date(op.occurredAt)
  const occurredAt = occurred.getTime() > now.getTime() + MAX_FUTURE_MS ? now : occurred

  return db.transaction(async (tx) => {
    const actor = (await membersById(tx, device.businessId, [op.actorId])).get(op.actorId) ?? null
    const inserted = await tx
      .insert(syncOps)
      .values({
        id: op.id,
        businessId: device.businessId,
        deviceId: device.deviceId,
        type: op.type,
        actorMembershipId: actor?.membershipId ?? null,
        payload: op.payload,
        occurredAt,
        status: 'applied',
      })
      .onConflictDoNothing()
      .returning({ id: syncOps.id })
    if (inserted.length === 0) return earlierResult(tx, device, op.id)

    const reject = async (code: string, message: string): Promise<OpResult> => {
      await tx
        .update(syncOps)
        .set({ status: 'rejected', errorCode: code, errorMessage: message })
        .where(eq(syncOps.id, op.id))
      return { id: op.id, status: 'rejected', code, message }
    }
    if (!actor) return reject('forbidden', 'The person who did this is not part of this business.')
    try {
      // Savepoint: a rejected op leaves nothing behind but its sync_ops row.
      await tx.transaction((sp) => HANDLERS[op.type](sp, { device, opId: op.id, actor, occurredAt }, op))
      return { id: op.id, status: 'applied' }
    } catch (e) {
      if (e instanceof DomainError) return reject(e.code, e.message)
      const code = integrityViolation(e)
      if (code) return reject('conflict', 'This operation clashes with data already on the server.')
      throw e
    }
  })
}

// --------------------------------------------------------------------- pull

function hashOf(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}

export async function catalogSection(db: Db | Tx, businessId: string): Promise<CatalogSection> {
  const [itemRows, packRows, barcodeRows, categoryRows, groupRows] = await Promise.all([
    db
      .select()
      .from(items)
      .where(and(eq(items.businessId, businessId), eq(items.active, true)))
      .orderBy(asc(items.id)),
    db
      .select({ p: itemPacks })
      .from(itemPacks)
      .innerJoin(items, eq(items.id, itemPacks.itemId))
      .where(and(eq(itemPacks.businessId, businessId), eq(itemPacks.active, true), eq(items.active, true)))
      .orderBy(asc(itemPacks.id)),
    db
      .select({ b: itemBarcodes, packActive: itemPacks.active })
      .from(itemBarcodes)
      .innerJoin(items, eq(items.id, itemBarcodes.itemId))
      .leftJoin(itemPacks, eq(itemPacks.id, itemBarcodes.packId))
      .where(and(eq(itemBarcodes.businessId, businessId), eq(items.active, true)))
      .orderBy(asc(itemBarcodes.barcode)),
    db
      .select()
      .from(categories)
      .where(and(eq(categories.businessId, businessId), eq(categories.active, true)))
      .orderBy(asc(categories.id)),
    db
      .select()
      .from(itemGroups)
      .where(and(eq(itemGroups.businessId, businessId), eq(itemGroups.active, true)))
      .orderBy(asc(itemGroups.id)),
  ])
  return {
    items: itemRows.map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      baseUnit: i.baseUnit,
      fractional: i.fractional,
      priceCents: i.priceCents,
      floorCents: i.floorCents,
      taxCategory: i.taxCategory,
      lowStockMilli: i.lowStockMilli,
      categoryId: i.categoryId,
      groupId: i.groupId,
      attributes: (i.attributes ?? {}) as Record<string, string>,
    })),
    packs: packRows.map(({ p }) => ({
      id: p.id,
      itemId: p.itemId,
      name: p.name,
      baseQtyMilli: p.baseQtyMilli,
      priceCents: p.priceCents,
      floorCents: p.floorCents,
    })),
    barcodes: barcodeRows
      .filter((r) => r.b.packId === null || r.packActive === true)
      .map(({ b }) => ({ barcode: b.barcode, itemId: b.itemId, packId: b.packId })),
    categories: categoryRows.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, sortOrder: c.sortOrder })),
    groups: groupRows.map((g) => ({ id: g.id, name: g.name, attributeKeys: g.attributeKeys })),
  }
}

async function stockSection(db: Db | Tx, device: DeviceAuth): Promise<StockSection> {
  const rows = await db
    .select({ itemId: outletStock.itemId, onHandMilli: outletStock.onHandMilli })
    .from(outletStock)
    .where(
      and(
        eq(outletStock.businessId, device.businessId),
        eq(outletStock.outletId, device.outletId),
        ne(outletStock.onHandMilli, 0),
      ),
    )
    .orderBy(asc(outletStock.itemId))
  return { onHand: rows }
}

async function sectionData<S extends Section>(db: Db, device: DeviceAuth, s: S): Promise<SectionData[S]> {
  switch (s) {
    case 'catalog':
      return (await catalogSection(db, device.businessId)) as SectionData[S]
    case 'stock':
      return (await stockSection(db, device)) as SectionData[S]
    case 'staff':
      return { staff: await staffForDevice(db, device) } as SectionData[S]
    case 'orders':
      return { orders: await ordersForTill(db, device) } as SectionData[S]
  }
  throw new Error(`Unknown section ${String(s)}`)
}

function settingsOf(device: DeviceAuth, lastOrderSeq: number): TillSettings {
  return {
    businessName: device.businessName,
    outlet: { id: device.outletId, code: device.outletCode, name: device.outletName, active: device.outletActive },
    device: { id: device.deviceId, code: device.code, name: device.name },
    mode: device.mode,
    lastOrderSeq,
  }
}

/** One sync round: apply the pushed ops in order, record the device's check-in, then pull. */
export async function sync(db: Db, device: DeviceAuth, body: unknown, now = new Date()): Promise<SyncResponse> {
  const req = syncRequestSchema.safeParse(body)
  if (!req.success) throw new DomainError('invalid_input', 'The till sent a sync request the server cannot read.')
  const { ops, hashes, clock } = req.data

  const results: OpResult[] = []
  for (const raw of ops) results.push(await applyOp(db, device, raw, now))

  const [updated] = await db
    .update(devices)
    .set({
      lastSyncAt: now,
      clockJumps: sql`${devices.clockJumps} + ${clock.jumps}`,
      ...(clock.jumps > 0 ? { lastClockJumpAt: clock.lastJumpAt ? new Date(clock.lastJumpAt) : now } : {}),
    })
    .where(eq(devices.id, device.deviceId))
    .returning({ lastOrderSeq: devices.lastOrderSeq })

  const sections: SyncResponse['sections'] = {}
  const names: Section[] = ['catalog', 'stock', 'staff', 'orders']
  const data = await Promise.all(names.map((s) => sectionData(db, device, s)))
  names.forEach((s, i) => {
    const hash = hashOf(data[i])
    if (hashes[s] !== hash) (sections as Record<Section, unknown>)[s] = { hash, data: data[i] }
  })

  return {
    results,
    serverTime: now.toISOString(),
    settings: settingsOf(device, updated?.lastOrderSeq ?? device.lastOrderSeq),
    sections,
  }
}

/** Rejected ops of the business, newest first (for the admin). */
export async function rejectedOps(db: Db, businessId: string, deviceIds: string[], limit = 50) {
  if (deviceIds.length === 0) return []
  return db
    .select()
    .from(syncOps)
    .where(
      and(
        eq(syncOps.businessId, businessId),
        eq(syncOps.status, 'rejected'),
        inArray(syncOps.deviceId, deviceIds),
      ),
    )
    .orderBy(sql`${syncOps.receivedAt} desc`)
    .limit(limit)
}
