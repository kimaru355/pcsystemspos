import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, ilike, inArray, or, sql } from 'drizzle-orm'
import type { Db, Tx } from '@/db/client'
import {
  collectionLines,
  collections,
  customers,
  devices,
  itemPacks,
  items,
  orderLines,
  orders,
  outlets,
  payments,
  users,
} from '@/db/schema'
import { alias } from 'drizzle-orm/pg-core'
import { isUuid } from '@/domain/ids'
import type { Cents } from '@/domain/money'
import {
  applyCollection,
  applyCustomer,
  applyPayment,
  buildLines,
  checkNamedCustomer,
  orderFigures,
  parseCustomer,
  planCancelRemainder,
  planCheckout,
  refundableCents,
  statusOf,
  type BaseMove,
  type Customer,
  type OrderEvent,
  type OrderFigures,
  type OrderState,
  type RuleError,
  type RuleResult,
  type SellableUnit,
} from '@/domain/order-state'
import type { CollectionRecord, PaymentAdd, SaleCheckout } from '@/domain/sync-ops'
import { sellableUnit, type CatalogItem, type CatalogPack } from '@/domain/till-data'
import { DomainError } from '@/server/errors'
import { assertCan, type TenantCtx } from '@/server/tenant'
import { recordAudit } from './audit'
import type { DeviceAuth } from './devices'
import { applyMovement } from './stock'
import { membersById, type OpActor } from './till-auth'

/*
 * Orders on the server. Till operations (applied by the sync service inside its per-op
 * transaction) and the admin's acts both load the stored order as an `OrderState`, run the
 * shared domain transition, then write the difference.
 *
 * Lock order: the order row (FOR UPDATE), then items sorted by id with their outlet_stock rows
 * (applyMovement), as everywhere else.
 */

export type OpContext = {
  device: DeviceAuth
  opId: string
  actor: OpActor
  occurredAt: Date
}

const REASON_MAX = 200

function unwrap<T>(r: RuleResult<T>): T {
  if (!r.ok) throw new DomainError(r.error.code, r.error.message)
  return r
}

function ruleError(e: RuleError): never {
  throw new DomainError(e.code, e.message)
}

// -------------------------------------------------------------------- loading

type OrderRow = typeof orders.$inferSelect

/**
 * Order states by id (business-scoped), with their events when asked. Missing ids are left out.
 */
export async function loadOrderStates(
  db: Db | Tx,
  businessId: string,
  orderIds: string[],
  opts: { events: boolean } = { events: true },
): Promise<Map<string, { state: OrderState; row: OrderRow }>> {
  const ids = [...new Set(orderIds)].filter(isUuid)
  if (ids.length === 0) return new Map()
  const creator = alias(users, 'creator')
  const canceller = alias(users, 'canceller')
  const orderRows = await db
    .select({ o: orders, creatorName: creator.name, cancellerName: canceller.name })
    .from(orders)
    .innerJoin(creator, eq(creator.id, orders.createdBy))
    .leftJoin(canceller, eq(canceller.id, orders.cancelledBy))
    .where(and(eq(orders.businessId, businessId), inArray(orders.id, ids)))
  if (orderRows.length === 0) return new Map()
  const found = orderRows.map((r) => r.o.id)
  const [lineRows, paymentRows, collectionRows] = await Promise.all([
    db
      .select()
      .from(orderLines)
      .where(and(eq(orderLines.businessId, businessId), inArray(orderLines.orderId, found)))
      .orderBy(asc(orderLines.orderId), asc(orderLines.position)),
    db
      .select({ p: payments, actorName: users.name })
      .from(payments)
      .innerJoin(users, eq(users.id, payments.actorUserId))
      .where(and(eq(payments.businessId, businessId), inArray(payments.orderId, found)))
      .orderBy(asc(payments.occurredAt), asc(payments.createdAt)),
    opts.events
      ? db
          .select({ c: collections, actorName: users.name })
          .from(collections)
          .innerJoin(users, eq(users.id, collections.actorUserId))
          .where(and(eq(collections.businessId, businessId), inArray(collections.orderId, found)))
          .orderBy(asc(collections.occurredAt), asc(collections.createdAt))
      : Promise.resolve([]),
  ])

  const out = new Map<string, { state: OrderState; row: OrderRow }>()
  for (const { o, creatorName, cancellerName } of orderRows) {
    const lines = lineRows
      .filter((l) => l.orderId === o.id)
      .map((l) => ({
        lineId: l.id,
        itemId: l.itemId,
        packId: l.packId,
        name: l.name,
        unitLabel: l.unitLabel,
        baseQtyPerUnitMilli: l.baseQtyPerUnitMilli,
        qtyMilli: l.qtyMilli,
        collectedMilli: l.collectedMilli,
        cancelledMilli: l.cancelledMilli,
        unitPriceCents: l.unitPriceCents,
        listPriceCents: l.listPriceCents,
        floorCents: l.floorCents,
        taxCategory: l.taxCategory,
        vatRateBp: l.vatRateBp,
        position: l.position,
      }))
    const pays = paymentRows.filter((p) => p.p.orderId === o.id)
    const paidCents = pays.reduce((s, { p }) => s + (p.kind === 'refund' ? -p.amountCents : p.amountCents), 0)
    const events: OrderEvent[] = []
    if (opts.events) {
      events.push({ kind: 'created', at: o.occurredAt.toISOString(), by: creatorName })
      for (const { p, actorName } of pays) {
        events.push({
          kind: p.kind,
          at: p.occurredAt.toISOString(),
          by: actorName,
          amountCents: p.amountCents,
          method: p.method,
          detail: p.reason ?? undefined,
        })
      }
      for (const { c, actorName } of collectionRows.filter((c) => c.c.orderId === o.id)) {
        events.push({
          kind: 'collection',
          at: c.occurredAt.toISOString(),
          by: actorName,
          amountCents: c.valueCents,
          creditGrantedCents: c.creditGrantedCents,
        })
      }
      if (o.cancelledAt) {
        events.push({
          kind: 'cancelled',
          at: o.cancelledAt.toISOString(),
          by: cancellerName ?? '',
          detail: o.cancelReason ?? undefined,
        })
      }
      // Newest first. Reversed before the stable sort so, at equal times, later events come first.
      events.reverse()
      events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    }
    out.set(o.id, {
      row: o,
      state: {
        id: o.id,
        number: o.number,
        outletId: o.outletId,
        status: o.status,
        customer: o.customerName && o.customerPhone ? { name: o.customerName, phone: o.customerPhone } : null,
        lines,
        paidCents,
        creditCents: o.creditCents,
        flagged: o.flaggedAt !== null,
        occurredAt: o.occurredAt.toISOString(),
        events,
      },
    })
  }
  return out
}

/** Locks the order row and loads its state (no events). */
async function lockOrderState(tx: Tx, businessId: string, orderId: string): Promise<{ state: OrderState; row: OrderRow }> {
  if (!isUuid(orderId)) throw new DomainError('not_found', 'That order was not found.')
  const [locked] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)))
    .for('update')
  if (!locked) throw new DomainError('not_found', 'That order was not found.')
  return (await loadOrderStates(tx, businessId, [orderId], { events: false })).get(orderId)!
}

// -------------------------------------------------------------------- writing

async function upsertCustomer(tx: Tx, businessId: string, c: Customer): Promise<string> {
  const [row] = await tx
    .insert(customers)
    .values({ businessId, name: c.name, phone: c.phone })
    .onConflictDoUpdate({
      target: [customers.businessId, customers.phone],
      set: { name: c.name, updatedAt: new Date() },
    })
    .returning({ id: customers.id })
  return row.id
}

/** Write what changed between two states of the same order (order row and line progress). */
async function persist(tx: Tx, businessId: string, before: OrderState, after: OrderState, at: Date): Promise<void> {
  const set: Partial<typeof orders.$inferInsert> = { updatedAt: new Date() }
  if (after.status !== before.status) {
    set.status = after.status
    set.closedAt = after.status === 'closed' ? at : null
  }
  if (after.creditCents !== before.creditCents) set.creditCents = after.creditCents
  if (after.flagged && !before.flagged) set.flaggedAt = new Date()
  if (after.customer && !before.customer) {
    set.customerId = await upsertCustomer(tx, businessId, after.customer)
    set.customerName = after.customer.name
    set.customerPhone = after.customer.phone
  }
  await tx.update(orders).set(set).where(and(eq(orders.id, after.id), eq(orders.businessId, businessId)))
  const beforeLines = new Map(before.lines.map((l) => [l.lineId, l]))
  for (const l of after.lines) {
    const b = beforeLines.get(l.lineId)
    if (b && (b.collectedMilli !== l.collectedMilli || b.cancelledMilli !== l.cancelledMilli)) {
      await tx
        .update(orderLines)
        .set({ collectedMilli: l.collectedMilli, cancelledMilli: l.cancelledMilli })
        .where(and(eq(orderLines.id, l.lineId), eq(orderLines.businessId, businessId)))
    }
  }
}

function approverCheck(members: Map<string, OpActor>) {
  return (id: string) => {
    const m = members.get(id)
    return !!m && (m.role === 'owner' || m.role === 'manager')
  }
}

function userOf(members: Map<string, OpActor>, membershipId: string | null): string | null {
  return membershipId === null ? null : (members.get(membershipId)?.userId ?? null)
}

function audit(tx: Tx, c: OpContext, action: string, entityType: string, entityId: string, data?: unknown, reason?: string) {
  return recordAudit(tx, {
    businessId: c.device.businessId,
    actorUserId: c.actor.userId,
    action,
    entityType,
    entityId,
    data,
    reason,
    deviceId: c.device.deviceId,
    occurredAt: c.occurredAt,
    opId: c.opId,
  })
}

async function writeCollection(
  tx: Tx,
  c: OpContext,
  order: OrderState,
  collectionId: string,
  result: { valueCents: Cents; creditGrantedCents: Cents; overCollected: boolean; moves: BaseMove[] },
  creditApproverUserId: string | null,
): Promise<void> {
  const businessId = c.device.businessId
  await tx.insert(collections).values({
    id: collectionId,
    orderId: order.id,
    businessId,
    valueCents: result.valueCents,
    creditGrantedCents: result.creditGrantedCents,
    approvedBy: result.creditGrantedCents > 0 ? creditApproverUserId : null,
    actorUserId: c.actor.userId,
    deviceId: c.device.deviceId,
    occurredAt: c.occurredAt,
  })
  // Items in a stable order so concurrent collections never deadlock.
  const moves = [...result.moves].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
  for (const m of moves) {
    const { movementId } = await applyMovement(tx, {
      businessId,
      outletId: order.outletId,
      itemId: m.itemId,
      kind: 'collect',
      qtyMilli: -m.baseQtyMilli,
      actorUserId: c.actor.userId,
      occurredAt: c.occurredAt,
      deviceId: c.device.deviceId,
      orderLineId: m.lineId,
    })
    await tx.insert(collectionLines).values({
      collectionId,
      businessId,
      orderLineId: m.lineId,
      qtyMilli: m.qtyMilli,
      baseQtyMilli: m.baseQtyMilli,
      movementId,
    })
  }
  if (result.creditGrantedCents > 0) {
    await audit(tx, c, 'order.credit', 'order', order.id, {
      number: order.number,
      creditCents: result.creditGrantedCents,
      approvedBy: creditApproverUserId,
    })
  }
  if (result.overCollected) {
    await audit(tx, c, 'order.over_collected', 'order', order.id, {
      number: order.number,
      valueCents: result.valueCents,
    })
  }
}

async function writePayment(
  tx: Tx,
  c: OpContext,
  orderId: string,
  number: string,
  p: { id: string; method: 'cash' | 'mark_paid'; amountCents: Cents; approverId: string | null },
  reason: string | null,
  approverUserId: string | null,
): Promise<void> {
  await tx.insert(payments).values({
    id: p.id,
    orderId,
    businessId: c.device.businessId,
    kind: 'payment',
    method: p.method,
    amountCents: p.amountCents,
    reason,
    approvedBy: p.method === 'mark_paid' ? approverUserId : null,
    actorUserId: c.actor.userId,
    deviceId: c.device.deviceId,
    occurredAt: c.occurredAt,
  })
  if (p.method === 'mark_paid') {
    await audit(
      tx,
      c,
      'order.mark_paid',
      'order',
      orderId,
      { number, paymentId: p.id, amountCents: p.amountCents, approvedBy: approverUserId },
      reason ?? undefined,
    )
  }
}

function assertSameOutlet(c: OpContext, row: OrderRow) {
  if (row.outletId !== c.device.outletId) {
    throw new DomainError('conflict', 'That order belongs to another outlet.')
  }
}

function customerOf(raw: { name: string; phone: string } | null): Customer | null {
  const r = parseCustomer(raw)
  if (!r.ok) ruleError(r.error)
  return r.customer
}

// ------------------------------------------------------------- till operations

/** Catalog units for the lines of a checkout, from the server's catalog (inactive items included). */
async function sellableUnits(tx: Tx, businessId: string, lines: SaleCheckout['order']['lines']) {
  const itemIds = [...new Set(lines.map((l) => l.itemId))]
  const packIds = [...new Set(lines.flatMap((l) => (l.packId ? [l.packId] : [])))]
  const [itemRows, packRows] = await Promise.all([
    tx.select().from(items).where(and(eq(items.businessId, businessId), inArray(items.id, itemIds))),
    packIds.length
      ? tx.select().from(itemPacks).where(and(eq(itemPacks.businessId, businessId), inArray(itemPacks.id, packIds)))
      : Promise.resolve([]),
  ])
  const itemById = new Map(itemRows.map((i) => [i.id, i]))
  const packById = new Map(packRows.map((p) => [p.id, p]))
  return (itemId: string, packId: string | null): SellableUnit | null => {
    const item = itemById.get(itemId)
    if (!item) return null
    const ci = { id: item.id, name: item.name, baseUnit: item.baseUnit, fractional: item.fractional, taxCategory: item.taxCategory } as CatalogItem
    if (packId === null) return sellableUnit(ci, null)
    const pack = packById.get(packId)
    if (!pack || pack.itemId !== itemId) return null
    return sellableUnit(ci, { id: pack.id, name: pack.name, baseQtyMilli: pack.baseQtyMilli } as CatalogPack)
  }
}

export async function applySaleCheckout(tx: Tx, c: OpContext, p: SaleCheckout): Promise<void> {
  const { device } = c
  const m = /^([A-Z0-9]{2,5})-(\d{2})-(\d{6})$/.exec(p.order.number)
  if (!m || m[1] !== device.outletCode || Number(m[3]) !== p.order.seq) {
    throw new DomainError('invalid_input', 'The order number does not match this till.')
  }
  const approverIds = [
    ...p.order.lines.flatMap((l) => (l.priceApproverId ? [l.priceApproverId] : [])),
    ...p.payments.flatMap((x) => (x.approverId ? [x.approverId] : [])),
    ...(p.collection?.creditApproverId ? [p.collection.creditApproverId] : []),
  ]
  const members = await membersById(tx, device.businessId, approverIds)
  const isApprover = approverCheck(members)
  const unitOf = await sellableUnits(tx, device.businessId, p.order.lines)
  const { lines } = unwrap(buildLines(p.order.lines, unitOf, isApprover))
  const plan = unwrap(
    planCheckout(
      {
        id: p.order.id,
        number: p.order.number,
        outletId: device.outletId,
        occurredAt: c.occurredAt.toISOString(),
        by: c.actor.name,
        customer: customerOf(p.order.customer),
        lines,
        payments: p.payments,
        collection: p.collection,
      },
      { mode: 'server', onHand: null, isApprover },
    ),
  )
  const order = plan.order
  const customerId = order.customer ? await upsertCustomer(tx, device.businessId, order.customer) : null
  await tx.insert(orders).values({
    id: order.id,
    businessId: device.businessId,
    outletId: device.outletId,
    deviceId: device.deviceId,
    number: order.number,
    seq: p.order.seq,
    customerId,
    customerName: order.customer?.name ?? null,
    customerPhone: order.customer?.phone ?? null,
    status: order.status,
    creditCents: order.creditCents,
    flaggedAt: order.flagged ? new Date() : null,
    createdBy: c.actor.userId,
    occurredAt: c.occurredAt,
    closedAt: order.status === 'closed' ? c.occurredAt : null,
  })
  const inputById = new Map(p.order.lines.map((l) => [l.id, l]))
  await tx.insert(orderLines).values(
    order.lines.map((l) => ({
      id: l.lineId,
      orderId: order.id,
      businessId: device.businessId,
      itemId: l.itemId,
      packId: l.packId,
      position: l.position,
      name: l.name,
      unitLabel: l.unitLabel,
      baseQtyPerUnitMilli: l.baseQtyPerUnitMilli,
      qtyMilli: l.qtyMilli,
      collectedMilli: l.collectedMilli,
      cancelledMilli: 0,
      unitPriceCents: l.unitPriceCents,
      listPriceCents: l.listPriceCents,
      floorCents: l.floorCents,
      taxCategory: l.taxCategory,
      vatRateBp: l.vatRateBp,
      priceApprovedBy: l.unitPriceCents < l.floorCents ? userOf(members, inputById.get(l.lineId)!.priceApproverId) : null,
    })),
  )
  for (const l of lines.filter((x) => x.unitPriceCents < x.floorCents)) {
    await audit(tx, c, 'order.price_override', 'order', order.id, {
      number: order.number,
      lineId: l.lineId,
      itemName: l.name,
      unitPriceCents: l.unitPriceCents,
      floorCents: l.floorCents,
      approvedBy: userOf(members, inputById.get(l.lineId)!.priceApproverId),
    })
  }
  for (const pay of plan.payments) {
    await writePayment(tx, c, order.id, order.number, pay.input, pay.reason, userOf(members, pay.input.approverId))
  }
  if (p.collection && plan.collection) {
    await writeCollection(tx, c, order, p.collection.id, plan.collection, userOf(members, p.collection.creditApproverId))
  }
  const [, , deviceCode] = m
  if (deviceCode === device.code) {
    await tx
      .update(devices)
      .set({ lastOrderSeq: sql`greatest(${devices.lastOrderSeq}, ${p.order.seq})` })
      .where(eq(devices.id, device.deviceId))
  }
}

export async function applyPaymentAdd(tx: Tx, c: OpContext, p: PaymentAdd): Promise<void> {
  const { state: before, row } = await lockOrderState(tx, c.device.businessId, p.orderId)
  assertSameOutlet(c, row)
  const members = await membersById(tx, c.device.businessId, p.payment.approverId ? [p.payment.approverId] : [])
  let after = applyCustomer(before, customerOf(p.customer))
  const r = unwrap(
    applyPayment(after, p.payment, { at: c.occurredAt.toISOString(), by: c.actor.name, isApprover: approverCheck(members) }),
  )
  after = r.order
  unwrap(checkNamedCustomer(after))
  await writePayment(tx, c, before.id, before.number, p.payment, r.reason, userOf(members, p.payment.approverId))
  await persist(tx, c.device.businessId, before, after, c.occurredAt)
}

export async function applyCollectionRecord(tx: Tx, c: OpContext, p: CollectionRecord): Promise<void> {
  const { state: before, row } = await lockOrderState(tx, c.device.businessId, p.orderId)
  assertSameOutlet(c, row)
  const approverId = p.collection.creditApproverId
  const members = await membersById(tx, c.device.businessId, approverId ? [approverId] : [])
  let after = applyCustomer(before, customerOf(p.customer))
  const r = unwrap(
    applyCollection(after, p.collection, {
      at: c.occurredAt.toISOString(),
      by: c.actor.name,
      mode: 'server',
      onHand: null,
      isApprover: approverCheck(members),
    }),
  )
  after = r.order
  unwrap(checkNamedCustomer(after))
  await writeCollection(tx, c, after, p.collection.id, r, userOf(members, approverId))
  await persist(tx, c.device.businessId, before, after, c.occurredAt)
}

/** Open orders of the device's outlet, plus those closed in the last two days (for look-up). */
export async function ordersForTill(db: Db | Tx, device: DeviceAuth, now = new Date()): Promise<OrderState[]> {
  const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, device.businessId),
        eq(orders.outletId, device.outletId),
        or(eq(orders.status, 'open'), gt(orders.closedAt, since)),
      ),
    )
    .orderBy(desc(orders.occurredAt), asc(orders.id))
    .limit(500)
  const states = await loadOrderStates(db, device.businessId, rows.map((r) => r.id))
  return rows.flatMap((r) => {
    const s = states.get(r.id)
    return s ? [s.state] : []
  })
}

// ------------------------------------------------------------------- admin

export type OrderListRow = {
  id: string
  number: string
  outletId: string
  outletCode: string
  status: 'open' | 'closed'
  customer: Customer | null
  occurredAt: Date
  flagged: boolean
  cancelled: boolean
  figures: OrderFigures
}

export type OrderFilter = {
  outletId?: string
  status?: 'open' | 'closed'
  search?: string
  flaggedOnly?: boolean
  limit?: number
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Newest first, outlets in scope. Search matches the number or the customer's name or phone. */
export async function listOrders(db: Db, ctx: TenantCtx, f: OrderFilter = {}): Promise<OrderListRow[]> {
  assertCan(ctx, 'order.view')
  if (ctx.outletScope !== 'all' && ctx.outletScope.length === 0) return []
  if (f.outletId !== undefined && (!isUuid(f.outletId) || (ctx.outletScope !== 'all' && !ctx.outletScope.includes(f.outletId)))) {
    return []
  }
  const term = f.search?.trim()
  const rows = await db
    .select({ id: orders.id, outletCode: outlets.code })
    .from(orders)
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .where(
      and(
        eq(orders.businessId, ctx.businessId),
        ctx.outletScope === 'all' ? undefined : inArray(orders.outletId, ctx.outletScope),
        f.outletId ? eq(orders.outletId, f.outletId) : undefined,
        f.status ? eq(orders.status, f.status) : undefined,
        f.flaggedOnly ? sql`${orders.flaggedAt} is not null` : undefined,
        term
          ? or(
              ilike(orders.number, `%${escapeLike(term)}%`),
              ilike(orders.customerName, `%${escapeLike(term)}%`),
              ilike(orders.customerPhone, `%${escapeLike(term.replace(/[\s-]/g, '').replace(/^0/, ''))}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(orders.occurredAt), desc(orders.createdAt), desc(orders.id))
    .limit(Math.min(Math.max(f.limit ?? 100, 1), 500))
  const states = await loadOrderStates(db, ctx.businessId, rows.map((r) => r.id), { events: false })
  return rows.flatMap((r) => {
    const s = states.get(r.id)
    if (!s) return []
    return [
      {
        id: s.state.id,
        number: s.state.number,
        outletId: s.state.outletId,
        outletCode: r.outletCode,
        status: s.state.status,
        customer: s.state.customer,
        occurredAt: s.row.occurredAt,
        flagged: s.state.flagged,
        cancelled: s.row.cancelledAt !== null,
        figures: orderFigures(s.state),
      },
    ]
  })
}

export type OrderDetail = {
  state: OrderState
  figures: OrderFigures
  outletCode: string
  outletName: string
  cancelledAt: Date | null
  cancelReason: string | null
  refundableCents: Cents
}

async function scopedOrder(db: Db | Tx, ctx: TenantCtx, orderId: string) {
  if (!isUuid(orderId)) throw new DomainError('not_found')
  const [o] = await db
    .select({ id: orders.id, outletId: orders.outletId, outletCode: outlets.code, outletName: outlets.name })
    .from(orders)
    .innerJoin(outlets, eq(outlets.id, orders.outletId))
    .where(and(eq(orders.id, orderId), eq(orders.businessId, ctx.businessId)))
  if (!o) throw new DomainError('not_found')
  if (ctx.outletScope !== 'all' && !ctx.outletScope.includes(o.outletId)) throw new DomainError('forbidden')
  return o
}

export async function getOrder(db: Db, ctx: TenantCtx, orderId: string): Promise<OrderDetail> {
  assertCan(ctx, 'order.view')
  const o = await scopedOrder(db, ctx, orderId)
  const { state, row } = (await loadOrderStates(db, ctx.businessId, [o.id])).get(o.id)!
  return {
    state,
    figures: orderFigures(state),
    outletCode: o.outletCode,
    outletName: o.outletName,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    refundableCents: refundableCents(state),
  }
}

function parseAdminReason(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s === '') throw new DomainError('invalid_input', `Give a reason for ${what}.`)
  if (s.length > REASON_MAX) throw new DomainError('invalid_input', `The reason must be at most ${REASON_MAX} characters.`)
  return s
}

/** Cancel everything not yet collected. The money side is a separate refund. */
export async function cancelRemainder(db: Db, ctx: TenantCtx, orderId: string, i: { reason: string }): Promise<void> {
  assertCan(ctx, 'order.cancel')
  const reason = parseAdminReason(i.reason, 'cancelling')
  await db.transaction(async (tx) => {
    await scopedOrder(tx, ctx, orderId)
    const { state: before } = await lockOrderState(tx, ctx.businessId, orderId)
    const plan = planCancelRemainder(before)
    if (!plan.ok) ruleError(plan.error)
    const now = new Date()
    await persist(tx, ctx.businessId, before, plan.order, now)
    await tx
      .update(orders)
      .set({ cancelledAt: now, cancelledBy: ctx.userId, cancelReason: reason })
      .where(eq(orders.id, orderId))
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'order.cancel_remainder',
      entityType: 'order',
      entityId: orderId,
      reason,
      data: { number: before.number, cancelled: plan.cancelled, refundableCents: refundableCents(plan.order) },
    })
  })
}

export const REFUND_METHODS = ['cash', 'mpesa', 'other'] as const
export type RefundMethod = (typeof REFUND_METHODS)[number]

/** Record money given back outside the system, up to what was paid beyond the order's total. */
export async function recordRefund(
  db: Db,
  ctx: TenantCtx,
  orderId: string,
  i: { amountCents: Cents; method: RefundMethod; reason: string },
): Promise<void> {
  assertCan(ctx, 'order.cancel')
  if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0) {
    throw new DomainError('invalid_input', 'Enter an amount above zero.')
  }
  if (!REFUND_METHODS.includes(i.method)) throw new DomainError('invalid_input', 'Choose how the money was returned.')
  const reason = parseAdminReason(i.reason, 'the refund')
  await db.transaction(async (tx) => {
    await scopedOrder(tx, ctx, orderId)
    const { state: before } = await lockOrderState(tx, ctx.businessId, orderId)
    const max = refundableCents(before)
    if (i.amountCents > max) {
      throw new DomainError(
        'invalid_input',
        max === 0 ? 'Nothing has been paid beyond the order total.' : 'That is more than was paid beyond the order total.',
      )
    }
    const now = new Date()
    const paymentId = randomUUID()
    await tx.insert(payments).values({
      id: paymentId,
      orderId,
      businessId: ctx.businessId,
      kind: 'refund',
      method: i.method,
      amountCents: i.amountCents,
      reason,
      actorUserId: ctx.userId,
      occurredAt: now,
    })
    const after = { ...before, paidCents: before.paidCents - i.amountCents }
    await persist(tx, ctx.businessId, before, { ...after, status: statusOf(after) }, now)
    await recordAudit(tx, {
      businessId: ctx.businessId,
      actorUserId: ctx.userId,
      action: 'order.refund',
      entityType: 'order',
      entityId: orderId,
      reason,
      data: { number: before.number, paymentId, amountCents: i.amountCents, method: i.method },
    })
  })
}
