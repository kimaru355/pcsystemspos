import type { Cents, Milli } from '@/domain/money'
import {
  applyCollection,
  applyCustomer,
  applyPayment,
  buildLines,
  checkNamedCustomer,
  formatOrderNumber,
  parseCustomer,
  planCheckout,
  type CollectionInput,
  type LineInput,
  type LineState,
  type OrderState,
  type PaymentInput,
  type RuleResult,
} from '@/domain/order-state'
import { can } from '@/domain/permissions'
import type { AdjustReason } from '@/domain/stock'
import { sellableUnit, type CatalogItem, type CatalogPack, type TillStaff } from '@/domain/till-data'
import type { TillEngine } from './engine'
import type { TillView } from './view'

/*
 * Till actions: build an operation from what the cashier entered, check it with the shared
 * rules against the till's view (stock as this device knows it), then queue it. Nothing here
 * needs the network.
 */

export type Actor = { membershipId: string; name: string; role: TillStaff['role'] }

export type CartLine = {
  id: string
  itemId: string
  packId: string | null
  qtyMilli: Milli
  unitPriceCents: Cents
  priceApproverId: string | null
}

export type CustomerDraft = { name: string; phone: string }

function uuid(): string {
  return crypto.randomUUID()
}

export function catalogIndex(view: TillView) {
  const items = new Map<string, CatalogItem>(view.catalog.items.map((i) => [i.id, i]))
  const packs = new Map<string, CatalogPack>(view.catalog.packs.map((p) => [p.id, p]))
  return { items, packs }
}

/** The approvers of this till: owners and managers with a PIN. */
export function approvers(view: TillView): TillStaff[] {
  return view.staff.filter((s) => (s.role === 'owner' || s.role === 'manager') && s.pin !== null)
}

function isApproverIn(view: TillView) {
  const ids = new Set(approvers(view).map((a) => a.membershipId))
  return (id: string) => ids.has(id)
}

/** Catalog price and floor of a cart line's unit. */
export function listPrice(view: TillView, itemId: string, packId: string | null): { priceCents: Cents; floorCents: Cents } | null {
  const { items, packs } = catalogIndex(view)
  const item = items.get(itemId)
  if (!item) return null
  if (packId === null) return { priceCents: item.priceCents, floorCents: item.floorCents }
  const pack = packs.get(packId)
  return pack ? { priceCents: pack.priceCents, floorCents: pack.floorCents } : null
}

export function cartLineStates(view: TillView, cart: CartLine[]): RuleResult<{ lines: LineState[]; inputs: LineInput[] }> {
  const { items, packs } = catalogIndex(view)
  const inputs: LineInput[] = cart.map((c) => {
    const p = listPrice(view, c.itemId, c.packId)
    return {
      id: c.id,
      itemId: c.itemId,
      packId: c.packId,
      qtyMilli: c.qtyMilli,
      unitPriceCents: c.unitPriceCents,
      listPriceCents: p?.priceCents ?? c.unitPriceCents,
      floorCents: p?.floorCents ?? 0,
      priceApproverId: c.priceApproverId,
    }
  })
  const r = buildLines(
    inputs,
    (itemId, packId) => {
      const item = items.get(itemId)
      if (!item) return null
      if (packId === null) return sellableUnit(item, null)
      const pack = packs.get(packId)
      return pack && pack.itemId === itemId ? sellableUnit(item, pack) : null
    },
    isApproverIn(view),
  )
  return r.ok ? { ok: true, lines: r.lines, inputs } : r
}

export type CheckoutDraft = {
  cart: CartLine[]
  customer: CustomerDraft
  payment: { method: 'cash' | 'mark_paid'; amountCents: Cents; reason: string; approverId: string | null } | null
  /** Sold-unit quantity to hand over now, by line id; missing or 0 = nothing. */
  collect: Record<string, Milli>
  creditApproverId: string | null
}

function collectionOf(draft: { collect: Record<string, Milli> }, creditApproverId: string | null): CollectionInput | null {
  const lines = Object.entries(draft.collect)
    .filter(([, q]) => q > 0)
    .map(([lineId, qtyMilli]) => ({ lineId, qtyMilli }))
  return lines.length === 0 ? null : { id: uuid(), lines, creditApproverId }
}

function paymentOf(p: CheckoutDraft['payment']): PaymentInput[] {
  if (!p || p.amountCents <= 0) return []
  return [
    {
      id: uuid(),
      method: p.method,
      amountCents: p.amountCents,
      reason: p.method === 'mark_paid' ? p.reason : null,
      approverId: p.method === 'mark_paid' ? p.approverId : null,
    },
  ]
}

/** Check a checkout against the rules without queuing it (for live feedback). */
export function previewCheckout(view: TillView, actor: Actor, draft: CheckoutDraft) {
  const built = cartLineStates(view, draft.cart)
  if (!built.ok) return built
  const customer = parseCustomer(draft.customer)
  if (!customer.ok) return customer
  return planCheckout(
    {
      id: 'preview',
      number: 'preview',
      outletId: view.settings?.outlet.id ?? '',
      occurredAt: new Date().toISOString(),
      by: actor.name,
      customer: customer.customer,
      lines: built.lines,
      payments: paymentOf(draft.payment),
      collection: collectionOf(draft, draft.creditApproverId),
    },
    { mode: 'till', onHand: view.onHand, isApprover: isApproverIn(view) },
  )
}

export async function checkout(
  engine: TillEngine,
  view: TillView,
  actor: Actor,
  draft: CheckoutDraft,
): Promise<RuleResult<{ order: OrderState }>> {
  if (!view.settings) return { ok: false, error: { code: 'conflict', message: 'The till has not synced yet.' } }
  const built = cartLineStates(view, draft.cart)
  if (!built.ok) return built
  const customer = parseCustomer(draft.customer)
  if (!customer.ok) return customer
  const occurredAt = new Date(engine.trustedNow()).toISOString()
  const payments = paymentOf(draft.payment)
  const collection = collectionOf(draft, draft.creditApproverId)
  const id = uuid()
  const input = {
    id,
    number: '',
    outletId: view.settings.outlet.id,
    occurredAt,
    by: actor.name,
    customer: customer.customer,
    lines: built.lines,
    payments,
    collection,
  }
  const ctx = { mode: 'till' as const, onHand: view.onHand, isApprover: isApproverIn(view) }
  // Check first, so a refused sale never uses up an order number.
  const check = planCheckout(input, ctx)
  if (!check.ok) return check
  const seq = await engine.nextOrderSeq()
  const number = formatOrderNumber(view.settings.outlet.code, view.settings.device.code, seq)
  const plan = planCheckout({ ...input, number }, ctx)
  if (!plan.ok) return plan
  await engine.enqueue(
    {
      id: uuid(),
      type: 'sale.checkout',
      actorId: actor.membershipId,
      occurredAt,
      payload: {
        order: { id, number, seq, customer: customer.customer, lines: built.inputs },
        payments,
        collection,
      },
    },
    { actorName: actor.name, lines: built.lines },
  )
  return { ok: true, order: plan.order }
}

export async function takePayment(
  engine: TillEngine,
  view: TillView,
  actor: Actor,
  order: OrderState,
  p: NonNullable<CheckoutDraft['payment']>,
  customerDraft: CustomerDraft,
): Promise<RuleResult<{ order: OrderState }>> {
  const customer = parseCustomer(customerDraft)
  if (!customer.ok) return customer
  const [payment] = paymentOf(p)
  if (!payment) return { ok: false, error: { code: 'invalid_input', message: 'Enter an amount above zero.' } }
  const occurredAt = new Date(engine.trustedNow()).toISOString()
  const r = applyPayment(applyCustomer(order, customer.customer), payment, {
    at: occurredAt,
    by: actor.name,
    isApprover: isApproverIn(view),
  })
  if (!r.ok) return r
  const named = checkNamedCustomer(r.order)
  if (!named.ok) return named
  await engine.enqueue(
    {
      id: uuid(),
      type: 'payment.add',
      actorId: actor.membershipId,
      occurredAt,
      payload: { orderId: order.id, payment, customer: order.customer ? null : customer.customer },
    },
    { actorName: actor.name },
  )
  return { ok: true, order: r.order }
}

export function previewCollection(view: TillView, actor: Actor, order: OrderState, collect: Record<string, Milli>, creditApproverId: string | null) {
  const c = collectionOf({ collect }, creditApproverId)
  if (!c) return { ok: false as const, error: { code: 'invalid_input' as const, message: 'Choose what the customer is taking.' } }
  return applyCollection(order, c, { at: '', by: actor.name, mode: 'till', onHand: view.onHand, isApprover: isApproverIn(view) })
}

export async function recordCollection(
  engine: TillEngine,
  view: TillView,
  actor: Actor,
  order: OrderState,
  collect: Record<string, Milli>,
  creditApproverId: string | null,
  customerDraft: CustomerDraft,
): Promise<RuleResult<{ order: OrderState }>> {
  const customer = parseCustomer(customerDraft)
  if (!customer.ok) return customer
  const c = collectionOf({ collect }, creditApproverId)
  if (!c) return { ok: false, error: { code: 'invalid_input', message: 'Choose what the customer is taking.' } }
  const occurredAt = new Date(engine.trustedNow()).toISOString()
  const r = applyCollection(applyCustomer(order, customer.customer), c, {
    at: occurredAt,
    by: actor.name,
    mode: 'till',
    onHand: view.onHand,
    isApprover: isApproverIn(view),
  })
  if (!r.ok) return r
  const named = checkNamedCustomer(r.order)
  if (!named.ok) return named
  await engine.enqueue(
    {
      id: uuid(),
      type: 'collection.record',
      actorId: actor.membershipId,
      occurredAt,
      payload: { orderId: order.id, collection: c, customer: order.customer ? null : customer.customer },
    },
    { actorName: actor.name },
  )
  return { ok: true, order: r.order }
}

export async function adjustStock(
  engine: TillEngine,
  actor: Actor,
  i: { itemId: string; deltaMilli: Milli; reason: AdjustReason; note: string },
): Promise<RuleResult<object>> {
  if (!can(actor.role, 'stock.adjust')) {
    return { ok: false, error: { code: 'forbidden', message: 'Only an owner or manager can adjust stock.' } }
  }
  if (!Number.isSafeInteger(i.deltaMilli) || i.deltaMilli === 0) {
    return { ok: false, error: { code: 'invalid_input', message: 'Enter the change, for example -2.' } }
  }
  const note = i.note.trim()
  if (i.reason === 'other' && note === '') {
    return { ok: false, error: { code: 'invalid_input', message: 'Add a note when the reason is Other.' } }
  }
  await engine.enqueue(
    {
      id: uuid(),
      type: 'stock.adjust',
      actorId: actor.membershipId,
      occurredAt: new Date(engine.trustedNow()).toISOString(),
      payload: { movementId: uuid(), itemId: i.itemId, deltaMilli: i.deltaMilli, reason: i.reason, note: note || null },
    },
    { actorName: actor.name },
  )
  return { ok: true }
}
