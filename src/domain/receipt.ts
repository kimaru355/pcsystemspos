import { formatKes, formatQty, lineGross, vatPortion, type Cents, type Milli } from './money'
import { orderFigures, type Customer, type OrderEvent, type OrderState } from './order-state'
import { effectiveMilli, outstandingMilli } from './orders'
import { vatRateBp, type TaxCategory } from './tax'
import { unitLabel } from './units'

/*
 * Receipts. One pure builder makes the document from an order and the event it is for, so the
 * till (offline) and the server issue the same receipt; renderers turn it into 48-column text
 * (80mm thermal, Font A), a short SMS, or ESC/POS bytes. The HTML view lives with the components.
 */

export type ReceiptKind = 'order' | 'collection'

export type ReceiptLine = {
  name: string
  qtyMilli: Milli
  unit: string
  unitPriceCents: Cents
  totalCents: Cents
  collectedMilli: Milli
  owedMilli: Milli
}

export type TaxLine = { category: TaxCategory; rateBp: number; grossCents: Cents; vatCents: Cents }

export type ReceiptDoc = {
  kind: ReceiptKind
  title: string
  business: string
  outlet: { code: string; name: string }
  orderNumber: string
  /** ISO time of the event. */
  at: string
  by: string
  customer: Customer | null
  lines: ReceiptLine[]
  /** Collection note: what was handed over this time. */
  takenNow: { name: string; qtyMilli: Milli; unit: string }[] | null
  /** The payment the receipt is for, if any. */
  payment: { method: string; amountCents: Cents; reference: string | null } | null
  totals: {
    totalCents: Cents
    vatCents: Cents
    paidCents: Cents
    balanceCents: Cents
    collectedValueCents: Cents
    creditInUseCents: Cents
  }
  taxes: TaxLine[]
  goodsOwed: boolean
  /** Filled in when KRA eTIMS is integrated. */
  kraInvoiceNumber: string | null
}

const METHOD_LABELS: Record<string, string> = { cash: 'Cash', mark_paid: 'Marked paid', mpesa: 'M-Pesa', other: 'Other' }

/** VAT by tax category over what is still sold on each line. */
export function taxBreakdown(order: Pick<OrderState, 'lines'>): TaxLine[] {
  const by = new Map<TaxCategory, TaxLine>()
  for (const l of order.lines) {
    const gross = lineGross(effectiveMilli(l), l.unitPriceCents)
    const t = by.get(l.taxCategory) ?? { category: l.taxCategory, rateBp: vatRateBp(l.taxCategory), grossCents: 0, vatCents: 0 }
    t.grossCents += gross
    t.vatCents += vatPortion(gross, l.vatRateBp)
    by.set(l.taxCategory, t)
  }
  return [...by.values()].sort((a, b) => a.category.localeCompare(b.category))
}

/**
 * The receipt for `event` (a payment or collection) as the order stands *after* it. Without an
 * event, an order receipt of the order as it stands now (a reprint, or an unpaid sale).
 */
export function buildReceipt(
  order: OrderState,
  place: { business: string; outlet: { code: string; name: string } },
  event: OrderEvent | null,
): ReceiptDoc {
  const kind: ReceiptKind = event?.kind === 'collection' ? 'collection' : 'order'
  const f = orderFigures(order)
  const byLine = new Map(order.lines.map((l) => [l.lineId, l]))
  const created = order.events.find((e) => e.kind === 'created')
  return {
    kind,
    title: kind === 'collection' ? 'Collection note' : 'Receipt',
    business: place.business,
    outlet: place.outlet,
    orderNumber: order.number,
    at: event?.at ?? created?.at ?? order.occurredAt,
    by: event?.by ?? created?.by ?? '',
    customer: order.customer,
    lines: order.lines
      .filter((l) => effectiveMilli(l) > 0)
      .map((l) => ({
        name: l.name,
        qtyMilli: effectiveMilli(l),
        unit: l.unitLabel,
        unitPriceCents: l.unitPriceCents,
        totalCents: lineGross(effectiveMilli(l), l.unitPriceCents),
        collectedMilli: l.collectedMilli,
        owedMilli: outstandingMilli(l),
      })),
    takenNow:
      kind === 'collection'
        ? (event?.lines ?? []).flatMap((r) => {
            const l = byLine.get(r.lineId)
            return l ? [{ name: l.name, qtyMilli: r.qtyMilli, unit: l.unitLabel }] : []
          })
        : null,
    payment:
      event?.kind === 'payment'
        ? { method: event.method ?? 'cash', amountCents: event.amountCents ?? 0, reference: event.reference ?? null }
        : null,
    totals: {
      totalCents: f.totalCents,
      vatCents: f.vatCents,
      paidCents: f.paidCents,
      balanceCents: f.balanceCents,
      collectedValueCents: f.collectedValueCents,
      creditInUseCents: f.creditInUseCents,
    },
    taxes: taxBreakdown(order),
    goodsOwed: f.goodsOutstanding,
    kraInvoiceNumber: null,
  }
}

// ---------------------------------------------------------------- renderers

const when = new Intl.DateTimeFormat('en-KE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})

export function receiptTime(iso: string): string {
  return when.format(new Date(iso))
}

const kes = (c: Cents) => formatKes(c).replace('KES ', '')

/** `left ....... right` in `width` columns; a long left side wraps above. */
function row(left: string, right: string, width: number): string[] {
  const room = width - right.length - 1
  if (left.length <= room) return [left + ' '.repeat(width - left.length - right.length) + right]
  return [...wrap(left, width), ' '.repeat(width - right.length) + right]
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > width) {
      out.push(line)
      line = ''
    }
    line = line ? `${line} ${word}` : word.slice(0, width)
  }
  if (line) out.push(line)
  return out
}

function center(text: string, width: number): string[] {
  return wrap(text, width).map((l) => ' '.repeat(Math.max(0, Math.floor((width - l.length) / 2))) + l)
}

/** Plain text for an 80mm printer (48 columns) or an email body. */
export function receiptText(d: ReceiptDoc, width = 48): string {
  const rule = '-'.repeat(width)
  const out: string[] = [
    ...center(d.business, width),
    ...center(`${d.outlet.name} (${d.outlet.code})`, width),
    '',
    ...center(d.title.toUpperCase(), width),
    ...row(d.orderNumber, receiptTime(d.at), width),
  ]
  if (d.customer) out.push(...wrap(`Customer: ${d.customer.name} ${d.customer.phone}`, width))
  out.push(rule)
  if (d.takenNow) {
    out.push('Taken now:')
    for (const t of d.takenNow) out.push(...wrap(`  ${formatQty(t.qtyMilli)} ${unitLabel(t.qtyMilli, t.unit)} ${t.name}`, width))
    out.push(rule)
  }
  for (const l of d.lines) {
    out.push(...wrap(l.name, width))
    out.push(...row(`  ${formatQty(l.qtyMilli)} ${unitLabel(l.qtyMilli, l.unit)} x ${kes(l.unitPriceCents)}`, kes(l.totalCents), width))
    if (l.owedMilli > 0) out.push(`  ${formatQty(l.collectedMilli)} collected, ${formatQty(l.owedMilli)} still to collect`)
  }
  out.push(rule)
  out.push(...row('TOTAL', formatKes(d.totals.totalCents), width))
  for (const t of d.taxes.filter((x) => x.rateBp > 0)) {
    out.push(...row(`  VAT ${t.category} ${t.rateBp / 100}% on ${kes(t.grossCents)}`, kes(t.vatCents), width))
  }
  if (d.payment) {
    const ref = d.payment.reference ? ` ${d.payment.reference}` : ''
    out.push(...row(`${METHOD_LABELS[d.payment.method] ?? d.payment.method}${ref}`, kes(d.payment.amountCents), width))
  }
  out.push(...row('Paid so far', kes(d.totals.paidCents), width))
  out.push(
    ...(d.totals.balanceCents >= 0
      ? row('Balance owed', kes(d.totals.balanceCents), width)
      : row('Paid beyond total', kes(-d.totals.balanceCents), width)),
  )
  if (d.totals.creditInUseCents > 0) out.push(...row('Goods on credit', kes(d.totals.creditInUseCents), width))
  out.push(d.goodsOwed ? 'Goods still to collect: see the lines above.' : 'All goods collected.')
  out.push(rule)
  out.push(...wrap(`Served by ${d.by}.`, width))
  out.push(`KRA invoice no: ${d.kraInvoiceNumber ?? '-'}`)
  out.push(...center('Thank you', width))
  return out.join('\n')
}

/** A short SMS (aims for one 160-character part). */
export function receiptSms(d: ReceiptDoc): string {
  const parts = [`${d.business}: ${d.orderNumber}`]
  if (d.payment) parts.push(`Paid ${formatKes(d.payment.amountCents)} ${METHOD_LABELS[d.payment.method] ?? ''}`.trim() + '.')
  if (d.takenNow) {
    const taken = d.takenNow.map((t) => `${formatQty(t.qtyMilli)} ${unitLabel(t.qtyMilli, t.unit)} ${t.name}`).join(', ')
    parts.push(`Collected ${taken}.`)
  }
  parts.push(`Total ${formatKes(d.totals.totalCents)}, balance ${formatKes(Math.max(0, d.totals.balanceCents))}.`)
  parts.push(d.goodsOwed ? 'Goods still to collect.' : 'All goods collected.')
  return parts.join(' ')
}

/** SMS parts: GSM-7 up to 160 characters, 153 per part after; anything else is UCS-2 (70/67). */
export function smsSegments(text: string): number {
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà]*$/.test(text)
  const [single, multi] = gsm ? [160, 153] : [70, 67]
  return text.length <= single ? 1 : Math.ceil(text.length / multi)
}

// --------------------------------------------------------------------- ESC/POS

/** ESC/POS bytes for a thermal printer: initialise, the text (ASCII), feed and cut. */
export function escposBytes(text: string): Uint8Array {
  const ascii = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x0A\x20-\x7E]/g, '?')
  const body = Array.from(ascii, (c) => c.charCodeAt(0))
  return new Uint8Array([0x1b, 0x40, ...body, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00])
}
