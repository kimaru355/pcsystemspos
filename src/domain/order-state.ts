import { lineGross, type Cents, type Milli } from './money'
import {
  checkCollection,
  isValidSoldQty,
  orderTotals,
  outstandingMilli,
  requiresNamedCustomer,
  toBaseMilli,
  type CollectionRequest,
  type OnHand,
  type OrderLine,
} from './orders'
import { normalizeKePhone } from './phone'
import { vatRateBp, type TaxCategory } from './tax'

/*
 * Order state and its transitions. Pure and shared: the till runs them to decide what it may do
 * offline and to replay its unsynced operations; the server runs the same functions on the
 * stored order before writing, so both agree on totals, the paid-before-collect rule and the
 * named-customer rule.
 *
 * Mode: the till refuses anything the rules forbid. The server ('server' mode) accepts a
 * collection beyond paid + credit when it has to (two tills offline collected against the same
 * payment: the goods have already left) and flags the order instead.
 */

export type RuleMode = 'till' | 'server'

export type RuleError = { code: 'invalid_input' | 'forbidden' | 'not_found' | 'conflict'; message: string }
export type RuleResult<T> = ({ ok: true } & T) | { ok: false; error: RuleError }

const INT4_MAX = 2147483647
const MAX_LINES = 200
const REASON_MAX = 200
const NAME_MAX = 100

export type Customer = { name: string; phone: string }

export type LineState = OrderLine & {
  packId: string | null
  name: string
  unitLabel: string
  baseQtyPerUnitMilli: Milli
  cancelledMilli: Milli
  listPriceCents: Cents
  floorCents: Cents
  taxCategory: TaxCategory
  position: number
}

export type OrderEvent = {
  kind: 'created' | 'payment' | 'refund' | 'collection' | 'cancelled'
  /** ISO time it happened (on the till for till actions). */
  at: string
  by: string
  amountCents?: Cents
  method?: string
  creditGrantedCents?: Cents
  detail?: string
  /** Not yet confirmed by the server (till only). */
  pending?: boolean
}

export type OrderState = {
  id: string
  number: string
  outletId: string
  status: 'open' | 'closed'
  customer: Customer | null
  lines: LineState[]
  /** Payments less refunds. */
  paidCents: Cents
  /** Credit approved so far. */
  creditCents: Cents
  flagged: boolean
  occurredAt: string
  /** Newest first. */
  events: OrderEvent[]
}

export type OrderFigures = {
  totalCents: Cents
  vatCents: Cents
  paidCents: Cents
  /** Total less paid; negative when overpaid. */
  balanceCents: Cents
  collectedValueCents: Cents
  /** Goods handed over beyond what is paid: what the customer owes for goods taken. */
  creditInUseCents: Cents
  goodsOutstanding: boolean
}

function fail(code: RuleError['code'], message: string): { ok: false; error: RuleError } {
  return { ok: false, error: { code, message } }
}

export function orderFigures(o: Pick<OrderState, 'lines' | 'paidCents'>): OrderFigures {
  const { grossCents, vatCents } = orderTotals(o.lines)
  const collectedValueCents = o.lines.reduce((s, l) => s + lineGross(l.collectedMilli, l.unitPriceCents), 0)
  return {
    totalCents: grossCents,
    vatCents,
    paidCents: o.paidCents,
    balanceCents: grossCents - o.paidCents,
    collectedValueCents,
    creditInUseCents: Math.max(0, collectedValueCents - o.paidCents),
    goodsOutstanding: o.lines.some((l) => outstandingMilli(l) > 0),
  }
}

/** Closed when nothing is left to collect and the total is paid. */
export function statusOf(o: Pick<OrderState, 'lines' | 'paidCents'>): 'open' | 'closed' {
  const f = orderFigures(o)
  return !f.goodsOutstanding && f.paidCents >= f.totalCents ? 'closed' : 'open'
}

function settle(o: OrderState): OrderState {
  return { ...o, status: statusOf(o) }
}

/** `OUTLET-DEVICE-SEQ`, e.g. KTL-03-000123. */
export function formatOrderNumber(outletCode: string, deviceCode: string, seq: number): string {
  return `${outletCode}-${deviceCode}-${String(seq).padStart(6, '0')}`
}

export function parseCustomer(raw: { name?: unknown; phone?: unknown } | null | undefined): RuleResult<{
  customer: Customer | null
}> {
  if (!raw) return { ok: true, customer: null }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const phoneRaw = typeof raw.phone === 'string' ? raw.phone.trim() : ''
  if (name === '' && phoneRaw === '') return { ok: true, customer: null }
  if (name === '' || name.length > NAME_MAX) return fail('invalid_input', "Enter the customer's name.")
  const phone = normalizeKePhone(phoneRaw)
  if (!phone) return fail('invalid_input', "Enter the customer's phone number, for example 0712 345 678.")
  return { ok: true, customer: { name, phone } }
}

function parseReason(v: unknown, what: string): RuleResult<{ reason: string }> {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s === '') return fail('invalid_input', `Give a reason for ${what}.`)
  if (s.length > REASON_MAX) return fail('invalid_input', `The reason must be at most ${REASON_MAX} characters.`)
  return { ok: true, reason: s }
}

// ------------------------------------------------------------------- lines

/** What the catalog says about one sellable unit (an item's base unit, or one of its packs). */
export type SellableUnit = {
  itemId: string
  packId: string | null
  name: string
  unitLabel: string
  baseQtyPerUnitMilli: Milli
  fractional: boolean
  taxCategory: TaxCategory
}

export type LineInput = {
  id: string
  itemId: string
  packId: string | null
  qtyMilli: Milli
  unitPriceCents: Cents
  /** The catalog price and floor the till showed when it sold the line. */
  listPriceCents: Cents
  floorCents: Cents
  /** Owner or manager who allowed a price below the floor. */
  priceApproverId: string | null
}

function isMoney(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= INT4_MAX
}

export function buildLines(
  inputs: LineInput[],
  unitOf: (itemId: string, packId: string | null) => SellableUnit | null,
  isApprover: (membershipId: string) => boolean,
): RuleResult<{ lines: LineState[] }> {
  if (inputs.length === 0) return fail('invalid_input', 'Add at least one item.')
  if (inputs.length > MAX_LINES) return fail('invalid_input', `An order can have at most ${MAX_LINES} lines.`)
  const ids = new Set<string>()
  const lines: LineState[] = []
  for (const [position, i] of inputs.entries()) {
    if (ids.has(i.id)) return fail('invalid_input', 'Two lines share an id.')
    ids.add(i.id)
    const unit = unitOf(i.itemId, i.packId)
    if (!unit) return fail('not_found', 'An item on the order is not in the catalog.')
    if (!isValidSoldQty(i.qtyMilli, i.packId !== null, unit.fractional)) {
      return fail(
        'invalid_input',
        i.packId !== null || !unit.fractional
          ? `${unit.name} is sold in whole ${unit.unitLabel} units.`
          : `Enter a quantity for ${unit.name}.`,
      )
    }
    try {
      toBaseMilli(i.qtyMilli, unit.baseQtyPerUnitMilli)
      lineGross(i.qtyMilli, i.unitPriceCents)
    } catch {
      return fail('invalid_input', `The quantity of ${unit.name} is too large.`)
    }
    if (!isMoney(i.unitPriceCents) || !isMoney(i.listPriceCents) || !isMoney(i.floorCents)) {
      return fail('invalid_input', `The price of ${unit.name} is not valid.`)
    }
    if (i.floorCents > i.listPriceCents) return fail('invalid_input', `The lowest price of ${unit.name} is above its price.`)
    if (i.unitPriceCents < i.floorCents) {
      if (i.priceApproverId === null || !isApprover(i.priceApproverId)) {
        return fail('forbidden', `A price below the lowest price for ${unit.name} needs a manager's approval.`)
      }
    }
    lines.push({
      lineId: i.id,
      itemId: i.itemId,
      packId: i.packId,
      name: unit.name,
      unitLabel: unit.unitLabel,
      baseQtyPerUnitMilli: unit.baseQtyPerUnitMilli,
      qtyMilli: i.qtyMilli,
      collectedMilli: 0,
      cancelledMilli: 0,
      unitPriceCents: i.unitPriceCents,
      listPriceCents: i.listPriceCents,
      floorCents: i.floorCents,
      taxCategory: unit.taxCategory,
      vatRateBp: vatRateBp(unit.taxCategory),
      position,
    })
  }
  return { ok: true, lines }
}

// --------------------------------------------------------------- payments

export type PaymentInput = {
  id: string
  /** `mpesa` payments are recorded by the server only (STK callback, paybill match). */
  method: 'cash' | 'mark_paid' | 'mpesa'
  amountCents: Cents
  reason: string | null
  approverId: string | null
}

/** What a till may record itself (M-Pesa is recorded by the server). */
export type TillPaymentInput = PaymentInput & { method: 'cash' | 'mark_paid' }

export function applyPayment(
  order: OrderState,
  p: PaymentInput,
  ctx: { at: string; by: string; isApprover: (membershipId: string) => boolean },
): RuleResult<{ order: OrderState; reason: string | null }> {
  if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) {
    return fail('invalid_input', 'Enter an amount above zero.')
  }
  if (!Number.isSafeInteger(order.paidCents + p.amountCents)) return fail('invalid_input', 'That amount is too large.')
  let reason: string | null = null
  if (p.method === 'mark_paid') {
    if (p.approverId === null || !ctx.isApprover(p.approverId)) {
      return fail('forbidden', "Marking paid needs a manager's approval.")
    }
    const r = parseReason(p.reason, 'marking paid')
    if (!r.ok) return r
    reason = r.reason
  } else if (p.method !== 'cash' && p.method !== 'mpesa') {
    return fail('invalid_input', 'Choose a payment method.')
  }
  const next: OrderState = {
    ...order,
    paidCents: order.paidCents + p.amountCents,
    events: [
      { kind: 'payment', at: ctx.at, by: ctx.by, amountCents: p.amountCents, method: p.method, detail: reason ?? undefined },
      ...order.events,
    ],
  }
  return { ok: true, order: settle(next), reason }
}

// ------------------------------------------------------------ collections

export type CollectionInput = {
  id: string
  lines: CollectionRequest
  /** Owner or manager who approved handing over goods beyond what is paid. */
  creditApproverId: string | null
}

export type BaseMove = { lineId: string; itemId: string; qtyMilli: Milli; baseQtyMilli: Milli }

/** Value of handing over `request` now, valued cumulatively per line (see checkCollection). */
function requestValueCents(lines: LineState[], request: CollectionRequest): Cents {
  const byId = new Map(lines.map((l) => [l.lineId, l]))
  return request.reduce((sum, r) => {
    const l = byId.get(r.lineId)!
    return sum + lineGross(l.collectedMilli + r.qtyMilli, l.unitPriceCents) - lineGross(l.collectedMilli, l.unitPriceCents)
  }, 0)
}

export function applyCollection(
  order: OrderState,
  c: CollectionInput,
  ctx: {
    at: string
    by: string
    mode: RuleMode
    /** On-hand per item in base units; null skips the stock check (the server). */
    onHand: OnHand | null
    isApprover: (membershipId: string) => boolean
  },
): RuleResult<{
  order: OrderState
  valueCents: Cents
  creditGrantedCents: Cents
  overCollected: boolean
  moves: BaseMove[]
}> {
  const check = checkCollection({
    lines: order.lines,
    paidCents: order.paidCents,
    creditCents: order.creditCents,
    request: c.lines,
    onHandMilli: ctx.onHand,
  })
  let creditGrantedCents = 0
  let overCollected = false
  if (!check.ok) {
    switch (check.reason) {
      case 'invalid_request':
        return fail('invalid_input', 'Choose what the customer is taking.')
      case 'exceeds_outstanding':
        return fail('invalid_input', 'That is more than is left to collect.')
      case 'exceeds_stock':
        return fail('conflict', 'There is not enough stock at this outlet for that.')
      case 'exceeds_paid':
        if (c.creditApproverId !== null && ctx.isApprover(c.creditApproverId)) {
          creditGrantedCents = check.shortfallCents
        } else if (ctx.mode === 'server') {
          overCollected = true
        } else {
          return fail('forbidden', "That is more than has been paid. Giving it on credit needs a manager's approval.")
        }
    }
  }
  const valueCents = requestValueCents(order.lines, c.lines)
  const qty = new Map(c.lines.map((r) => [r.lineId, r.qtyMilli]))
  const moves: BaseMove[] = []
  const lines = order.lines.map((l) => {
    const q = qty.get(l.lineId)
    if (q === undefined) return l
    moves.push({ lineId: l.lineId, itemId: l.itemId, qtyMilli: q, baseQtyMilli: toBaseMilli(q, l.baseQtyPerUnitMilli) })
    return { ...l, collectedMilli: l.collectedMilli + q }
  })
  const next: OrderState = {
    ...order,
    lines,
    creditCents: order.creditCents + creditGrantedCents,
    flagged: order.flagged || overCollected,
    events: [
      { kind: 'collection', at: ctx.at, by: ctx.by, amountCents: valueCents, creditGrantedCents },
      ...order.events,
    ],
  }
  return { ok: true, order: settle(next), valueCents, creditGrantedCents, overCollected, moves }
}

// --------------------------------------------------------------- customer

/** Sets the customer when the order has none; an order's customer never changes once set. */
export function applyCustomer(order: OrderState, customer: Customer | null): OrderState {
  return order.customer === null && customer !== null ? { ...order, customer } : order
}

export function checkNamedCustomer(order: OrderState): RuleResult<object> {
  if (
    order.customer === null &&
    requiresNamedCustomer({ lines: order.lines, paidCents: order.paidCents, creditCents: order.creditCents })
  ) {
    return fail('invalid_input', "Something is left owed, so add the customer's name and phone.")
  }
  return { ok: true }
}

// --------------------------------------------------------------- checkout

export type CheckoutInput = {
  id: string
  number: string
  outletId: string
  occurredAt: string
  by: string
  customer: Customer | null
  lines: LineState[]
  payments: PaymentInput[]
  collection: CollectionInput | null
}

/** A whole sale: the new order, its payments and what the customer takes now, checked as one. */
export function planCheckout(
  input: CheckoutInput,
  ctx: { mode: RuleMode; onHand: OnHand | null; isApprover: (membershipId: string) => boolean },
): RuleResult<{
  order: OrderState
  payments: { input: PaymentInput; reason: string | null }[]
  collection: { valueCents: Cents; creditGrantedCents: Cents; overCollected: boolean; moves: BaseMove[] } | null
}> {
  if (input.lines.length === 0) return fail('invalid_input', 'Add at least one item.')
  let order: OrderState = settle({
    id: input.id,
    number: input.number,
    outletId: input.outletId,
    status: 'open',
    customer: input.customer,
    lines: input.lines,
    paidCents: 0,
    creditCents: 0,
    flagged: false,
    occurredAt: input.occurredAt,
    events: [{ kind: 'created', at: input.occurredAt, by: input.by }],
  })
  const paymentIds = new Set<string>()
  const payments: { input: PaymentInput; reason: string | null }[] = []
  for (const p of input.payments) {
    if (paymentIds.has(p.id)) return fail('invalid_input', 'Two payments share an id.')
    paymentIds.add(p.id)
    const r = applyPayment(order, p, { at: input.occurredAt, by: input.by, isApprover: ctx.isApprover })
    if (!r.ok) return r
    order = r.order
    payments.push({ input: p, reason: r.reason })
  }
  let collection = null
  if (input.collection !== null) {
    const r = applyCollection(order, input.collection, {
      at: input.occurredAt,
      by: input.by,
      mode: ctx.mode,
      onHand: ctx.onHand,
      isApprover: ctx.isApprover,
    })
    if (!r.ok) return r
    order = r.order
    collection = {
      valueCents: r.valueCents,
      creditGrantedCents: r.creditGrantedCents,
      overCollected: r.overCollected,
      moves: r.moves,
    }
  }
  const named = checkNamedCustomer(order)
  if (!named.ok) return named
  return { ok: true, order, payments, collection }
}

// ------------------------------------------------------------ admin acts

/** Cancel every line's uncollected quantity. */
export function planCancelRemainder(order: OrderState): RuleResult<{ order: OrderState; cancelled: { lineId: string; qtyMilli: Milli }[] }> {
  const cancelled = order.lines
    .map((l) => ({ lineId: l.lineId, qtyMilli: outstandingMilli(l) }))
    .filter((c) => c.qtyMilli > 0)
  if (cancelled.length === 0) return fail('conflict', 'Nothing is left to collect on this order.')
  const lines = order.lines.map((l) => ({ ...l, cancelledMilli: l.cancelledMilli + outstandingMilli(l) }))
  return { ok: true, order: settle({ ...order, lines }), cancelled }
}

/** The most that can be refunded: what was paid beyond the order's (remaining) total. */
export function refundableCents(order: Pick<OrderState, 'lines' | 'paidCents'>): Cents {
  return Math.max(0, order.paidCents - orderFigures(order).totalCents)
}
