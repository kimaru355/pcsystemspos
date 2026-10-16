import { lineGross, vatPortion, type Cents, type Milli } from './money'

export type OrderLine = {
  lineId: string
  itemId: string
  qtyMilli: Milli
  unitPriceCents: Cents
  vatRateBp: number
  collectedMilli: Milli
}

export type CollectionRequest = { lineId: string; qtyMilli: Milli }[]

export type CollectionCheck =
  | { ok: true; valueCents: Cents }
  | { ok: false; reason: 'invalid_request' | 'exceeds_outstanding' | 'exceeds_stock'; lineId: string }
  | { ok: false; reason: 'exceeds_paid'; shortfallCents: Cents }

export function orderTotals(lines: OrderLine[]): { grossCents: Cents; vatCents: Cents } {
  let grossCents = 0
  let vatCents = 0
  for (const l of lines) {
    const gross = lineGross(l.qtyMilli, l.unitPriceCents)
    grossCents += gross
    vatCents += vatPortion(gross, l.vatRateBp)
  }
  return { grossCents, vatCents }
}

export function outstandingMilli(line: OrderLine): Milli {
  return line.qtyMilli - line.collectedMilli
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

/**
 * The paid-before-collect rule. Checks, in order: request validity, outstanding quantity
 * per line, stock per item, and finally that the value handed over (earlier collections
 * plus this request) does not exceed what has been paid plus approved credit.
 */
export function checkCollection(input: {
  lines: OrderLine[]
  paidCents: Cents
  creditCents: Cents
  request: CollectionRequest
  onHandMilli: Record<string, Milli>
}): CollectionCheck {
  const { lines, paidCents, creditCents, request, onHandMilli } = input
  const byId = new Map(lines.map((l) => [l.lineId, l]))

  const seen = new Set<string>()
  for (const r of request) {
    if (!byId.has(r.lineId) || seen.has(r.lineId) || !Number.isInteger(r.qtyMilli) || r.qtyMilli <= 0) {
      return { ok: false, reason: 'invalid_request', lineId: r.lineId }
    }
    seen.add(r.lineId)
  }

  for (const r of request) {
    if (r.qtyMilli > outstandingMilli(byId.get(r.lineId)!)) {
      return { ok: false, reason: 'exceeds_outstanding', lineId: r.lineId }
    }
  }

  const requestedByItem = new Map<string, Milli>()
  for (const r of request) {
    const itemId = byId.get(r.lineId)!.itemId
    const total = (requestedByItem.get(itemId) ?? 0) + r.qtyMilli
    requestedByItem.set(itemId, total)
    if (total > (onHandMilli[itemId] ?? 0)) {
      return { ok: false, reason: 'exceeds_stock', lineId: r.lineId }
    }
  }

  const requestValue = request.reduce(
    (sum, r) => sum + lineGross(r.qtyMilli, byId.get(r.lineId)!.unitPriceCents),
    0,
  )
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
