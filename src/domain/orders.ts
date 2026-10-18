import { lineGross, vatPortion, type Cents, type Milli } from './money'

/**
 * A line of an order. Quantities are in the **sold unit**: the item's base unit, or a pack of
 * `baseQtyPerUnitMilli` base units. `cancelledMilli` is the part an admin cancelled.
 */
export type OrderLine = {
  lineId: string
  itemId: string
  qtyMilli: Milli
  unitPriceCents: Cents
  vatRateBp: number
  collectedMilli: Milli
  /** Base units per sold unit; default 1000 (sold in the base unit). */
  baseQtyPerUnitMilli?: Milli
  /** Default 0. */
  cancelledMilli?: Milli
}

export type CollectionRequest = { lineId: string; qtyMilli: Milli }[]

export type CollectionCheck =
  | { ok: true; valueCents: Cents }
  | { ok: false; reason: 'invalid_request'; lineId: string | null }
  | { ok: false; reason: 'exceeds_outstanding' | 'exceeds_stock'; lineId: string }
  | { ok: false; reason: 'exceeds_paid'; shortfallCents: Cents }

/** Base units moved by `qtyMilli` sold units. Exact: packs sell in whole numbers (see `isValidSoldQty`). */
export function toBaseMilli(qtyMilli: Milli, baseQtyPerUnitMilli: Milli = 1000): Milli {
  const product = qtyMilli * baseQtyPerUnitMilli
  if (!Number.isSafeInteger(product) || product % 1000 !== 0) {
    throw new RangeError('That quantity does not convert to whole thousandths of the base unit.')
  }
  return product / 1000
}

/**
 * A sold quantity is valid when it is a positive whole number of thousandths, a whole number of
 * packs, and a whole number of base units unless the item is fractional.
 */
export function isValidSoldQty(qtyMilli: Milli, soldInPack: boolean, fractional: boolean): boolean {
  if (!Number.isSafeInteger(qtyMilli) || qtyMilli <= 0) return false
  if (soldInPack || !fractional) return qtyMilli % 1000 === 0
  return true
}

/** Quantity still sold on the line: ordered less cancelled. */
export function effectiveMilli(line: OrderLine): Milli {
  return line.qtyMilli - (line.cancelledMilli ?? 0)
}

export function lineValueCents(line: OrderLine): Cents {
  return lineGross(effectiveMilli(line), line.unitPriceCents)
}

export function orderTotals(lines: OrderLine[]): { grossCents: Cents; vatCents: Cents } {
  let grossCents = 0
  let vatCents = 0
  for (const l of lines) {
    const gross = lineValueCents(l)
    grossCents += gross
    vatCents += vatPortion(gross, l.vatRateBp)
  }
  return { grossCents, vatCents }
}

export function outstandingMilli(line: OrderLine): Milli {
  return effectiveMilli(line) - line.collectedMilli
}

/** Base units still owed to the customer on a line. */
export function owedBaseMilli(line: OrderLine): Milli {
  return toBaseMilli(outstandingMilli(line), line.baseQtyPerUnitMilli)
}

/** Value of everything already handed over to the customer. */
export function collectedValueCents(lines: OrderLine[]): Cents {
  return lines.reduce((sum, l) => sum + lineGross(l.collectedMilli, l.unitPriceCents), 0)
}

/** Order gross minus paid. Negative means overpaid. */
export function balanceCents(lines: OrderLine[], paidCents: Cents): Cents {
  return orderTotals(lines).grossCents - paidCents
}

/** Collect everything still outstanding on every line. */
export function defaultCollectionRequest(lines: OrderLine[]): CollectionRequest {
  return lines
    .filter((l) => outstandingMilli(l) > 0)
    .map((l) => ({ lineId: l.lineId, qtyMilli: outstandingMilli(l) }))
}

export type OnHand = ReadonlyMap<string, Milli> | Readonly<Record<string, Milli>>

function onHandOf(onHand: OnHand, itemId: string): Milli {
  if (onHand instanceof Map) return onHand.get(itemId) ?? 0
  const rec = onHand as Readonly<Record<string, Milli>>
  return Object.hasOwn(rec, itemId) ? rec[itemId] : 0
}

/**
 * The paid-before-collect rule. Checks, in order: request validity (an empty request is
 * invalid), outstanding quantity per line, stock per item in base units (skipped when
 * `onHandMilli` is null: the server accepts negative stock on sync and flags it), and finally
 * that the value handed over (earlier collections plus this request) does not exceed what has
 * been paid plus approved credit.
 */
export function checkCollection(input: {
  lines: OrderLine[]
  paidCents: Cents
  creditCents: Cents
  request: CollectionRequest
  onHandMilli: OnHand | null
}): CollectionCheck {
  const { lines, paidCents, creditCents, request, onHandMilli } = input
  const byId = new Map(lines.map((l) => [l.lineId, l]))

  if (request.length === 0) return { ok: false, reason: 'invalid_request', lineId: null }
  const seen = new Set<string>()
  for (const r of request) {
    if (
      !byId.has(r.lineId) ||
      seen.has(r.lineId) ||
      !Number.isSafeInteger(r.qtyMilli) ||
      r.qtyMilli <= 0
    ) {
      return { ok: false, reason: 'invalid_request', lineId: r.lineId }
    }
    seen.add(r.lineId)
  }

  for (const r of request) {
    if (r.qtyMilli > outstandingMilli(byId.get(r.lineId)!)) {
      return { ok: false, reason: 'exceeds_outstanding', lineId: r.lineId }
    }
  }

  if (onHandMilli !== null) {
    const requestedByItem = new Map<string, Milli>()
    for (const r of request) {
      const line = byId.get(r.lineId)!
      const total = (requestedByItem.get(line.itemId) ?? 0) + toBaseMilli(r.qtyMilli, line.baseQtyPerUnitMilli)
      requestedByItem.set(line.itemId, total)
      if (total > onHandOf(onHandMilli, line.itemId)) {
        return { ok: false, reason: 'exceeds_stock', lineId: r.lineId }
      }
    }
  }

  // Value each requested line cumulatively so rounding is additive across visits:
  // a fully paid order can always be collected in full, however it is split.
  const requestValue = request.reduce((sum, r) => {
    const l = byId.get(r.lineId)!
    return (
      sum +
      lineGross(l.collectedMilli + r.qtyMilli, l.unitPriceCents) -
      lineGross(l.collectedMilli, l.unitPriceCents)
    )
  }, 0)
  const totalValue = collectedValueCents(lines) + requestValue
  const covered = paidCents + creditCents
  if (totalValue > covered) {
    return { ok: false, reason: 'exceeds_paid', shortfallCents: totalValue - covered }
  }
  return { ok: true, valueCents: requestValue }
}

/** A walk-in anonymous sale must be fully paid and fully collected, with no credit. */
export function requiresNamedCustomer(state: {
  lines: OrderLine[]
  paidCents: Cents
  creditCents: Cents
}): boolean {
  const { lines, paidCents, creditCents } = state
  return (
    creditCents > 0 ||
    paidCents < orderTotals(lines).grossCents ||
    lines.some((l) => outstandingMilli(l) > 0)
  )
}
