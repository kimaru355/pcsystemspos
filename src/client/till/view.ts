import type { Milli } from '@/domain/money'
import {
  applyCollection,
  applyCustomer,
  applyPayment,
  parseCustomer,
  planCheckout,
  type OrderState,
} from '@/domain/order-state'
import { owedBaseMilli } from '@/domain/orders'
import type { CatalogSection, SectionData, TillSettings, TillStaff } from '@/domain/till-data'
import type { OutboxRecord } from './db'

/*
 * The till's working view: the last pulled sections with the pending (unsynced) operations
 * replayed on top through the same domain rules the server uses. Pure.
 */

export type TillView = {
  settings: TillSettings | null
  catalog: CatalogSection
  staff: TillStaff[]
  /** Newest first; pending changes carry `pending` events. */
  orders: OrderState[]
  /** Base-unit on-hand per item: the server's figure plus pending movements. */
  onHand: Map<string, Milli>
  /** Base units owed to customers on open orders, per item. */
  owed: Map<string, Milli>
  pendingCount: number
}

const EMPTY_CATALOG: CatalogSection = { items: [], packs: [], barcodes: [], categories: [], groups: [] }

const anyone = () => true

function markPending(before: OrderState, after: OrderState): OrderState {
  const added = after.events.length - before.events.length
  return {
    ...after,
    events: after.events.map((e, i) => (i < added ? { ...e, pending: true } : e)),
  }
}

export function buildView(
  sections: Partial<SectionData>,
  settings: TillSettings | null,
  outbox: OutboxRecord[],
): TillView {
  const onHand = new Map<string, Milli>((sections.stock?.onHand ?? []).map((r) => [r.itemId, r.onHandMilli]))
  const orders = new Map<string, OrderState>((sections.orders?.orders ?? []).map((o) => [o.id, o]))
  const move = (itemId: string, delta: Milli) => onHand.set(itemId, (onHand.get(itemId) ?? 0) + delta)

  for (const { op, meta } of outbox) {
    const at = op.occurredAt
    const by = meta.actorName
    switch (op.type) {
      case 'stock.adjust':
        move(op.payload.itemId, op.payload.deltaMilli)
        break
      case 'sale.checkout': {
        if (orders.has(op.payload.order.id) || !meta.lines) break
        const customer = parseCustomer(op.payload.order.customer)
        const r = planCheckout(
          {
            id: op.payload.order.id,
            number: op.payload.order.number,
            outletId: settings?.outlet.id ?? '',
            occurredAt: at,
            by,
            customer: customer.ok ? customer.customer : null,
            lines: meta.lines.map((l) => ({ ...l, collectedMilli: 0, cancelledMilli: 0 })),
            payments: op.payload.payments,
            collection: op.payload.collection,
          },
          { mode: 'server', onHand: null, isApprover: anyone },
        )
        if (!r.ok) break
        orders.set(r.order.id, { ...r.order, events: r.order.events.map((e) => ({ ...e, pending: true })) })
        for (const m of r.collection?.moves ?? []) move(m.itemId, -m.baseQtyMilli)
        break
      }
      case 'payment.add': {
        const before = orders.get(op.payload.orderId)
        if (!before) break
        const c = parseCustomer(op.payload.customer)
        const withCustomer = applyCustomer(before, c.ok ? c.customer : null)
        const r = applyPayment(withCustomer, op.payload.payment, { at, by, isApprover: anyone })
        if (r.ok) orders.set(before.id, markPending(before, r.order))
        break
      }
      case 'collection.record': {
        const before = orders.get(op.payload.orderId)
        if (!before) break
        const c = parseCustomer(op.payload.customer)
        const withCustomer = applyCustomer(before, c.ok ? c.customer : null)
        const r = applyCollection(withCustomer, op.payload.collection, {
          at,
          by,
          mode: 'server',
          onHand: null,
          isApprover: anyone,
        })
        if (!r.ok) break
        orders.set(before.id, markPending(before, r.order))
        for (const m of r.moves) move(m.itemId, -m.baseQtyMilli)
        break
      }
    }
  }

  const owed = new Map<string, Milli>()
  for (const o of orders.values()) {
    if (o.status !== 'open') continue
    for (const l of o.lines) {
      const q = owedBaseMilli(l)
      if (q > 0) owed.set(l.itemId, (owed.get(l.itemId) ?? 0) + q)
    }
  }

  const all = [...orders.values()].sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
  )
  return {
    settings,
    catalog: sections.catalog ?? EMPTY_CATALOG,
    staff: sections.staff?.staff ?? [],
    orders: all,
    onHand,
    owed,
    pendingCount: outbox.length,
  }
}
