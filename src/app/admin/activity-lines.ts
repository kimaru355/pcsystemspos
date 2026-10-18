import { MODE_LABELS, type ConnectionMode } from '@/domain/connection-modes'
import { ADJUST_REASON_LABELS, type AdjustReason } from '@/domain/stock'
import { formatKes, formatQty } from '@/domain/money'
import { ROLE_LABELS, type Role } from '@/domain/permissions'
import type { Confirmation } from '@/components/shell/confirmation-line'
import type { ActivityEntry } from '@/server/services/activity'

export type Names = {
  outlets: Map<string, { code: string; name: string }>
  staff: Map<string, string>
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function modeLabel(m: unknown): string {
  return m === null ? 'business default' : (MODE_LABELS[m as ConnectionMode] ?? String(m))
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function text(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback
}

const ITEM_FIELDS: [string, string][] = [
  ['name', 'name'],
  ['sku', 'SKU'],
  ['baseUnit', 'unit'],
  ['fractional', 'fractions setting'],
  ['priceCents', 'price'],
  ['floorCents', 'lowest price'],
  ['taxCategory', 'tax category'],
  ['lowStockMilli', 'low stock level'],
  ['groupId', 'group'],
  ['categoryId', 'category'],
  ['brandId', 'brand'],
  ['attributes', 'attributes'],
]
const PACK_FIELDS: [string, string][] = [
  ['name', 'name'],
  ['baseQtyMilli', 'size'],
  ['priceCents', 'price'],
  ['floorCents', 'lowest price'],
]

/** "price, SKU changed" style summary of the fields that differ, then reopened/deactivated. */
function changeSummary(before: Record<string, unknown>, after: Record<string, unknown>, fields: [string, string][]): string {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const changed = fields.filter(([key]) => !same(before[key], after[key])).map(([, label]) => label)
  const parts: string[] = []
  if (changed.length) parts.push(`${changed.join(', ')} changed`)
  if (before.active !== after.active) parts.push(after.active ? 'reactivated' : 'deactivated')
  return parts.join(', ')
}

/** Confirmation line for the catalog, stock and import audit actions; null for any other action. */
function catalogConfirmation(e: ActivityEntry, data: Record<string, unknown>, names: Names): Confirmation | null {
  const by = e.actorName
  const at = e.at
  const before = rec(data.before)
  const after = rec(data.after)
  const withSummary = (name: string, summary: string) => `${name}${summary ? `: ${summary}` : ''}.`

  switch (e.action) {
    case 'item.create':
      return { code: text(data.sku, 'ITEM'), status: 'Item added', detail: `${text(data.name, 'An item')}.`, by, at }
    case 'item.update':
      return {
        code: text(after.sku, 'ITEM'),
        status: 'Item updated',
        detail: withSummary(text(after.name, 'An item'), changeSummary(before, after, ITEM_FIELDS)),
        by,
        at,
      }
    case 'pack.create': {
      const qty = typeof data.baseQtyMilli === 'number' ? `, ${formatQty(data.baseQtyMilli)} units` : ''
      return { code: 'PACK', status: 'Pack added', detail: `${text(data.name, 'A pack')}${qty}.`, by, at }
    }
    case 'pack.update':
      return {
        code: 'PACK',
        status: 'Pack updated',
        detail: withSummary(text(after.name, 'A pack'), changeSummary(before, after, PACK_FIELDS)),
        by,
        at,
      }
    case 'barcode.add':
      return { code: text(data.barcode, 'CODE'), status: 'Barcode added', detail: `to ${data.packId ? 'a pack' : 'an item'}.`, by, at }
    case 'barcode.remove':
      return { code: text(data.barcode, 'CODE'), status: 'Barcode removed', detail: `from ${data.packId ? 'a pack' : 'an item'}.`, by, at }
    case 'category.create':
      return { code: 'CAT', status: 'Category added', detail: `${text(data.name, 'A category')}.`, by, at }
    case 'category.update': {
      const name = text(after.name, 'A category')
      const renamed = before.name !== after.name ? `renamed from ${text(before.name, '')}` : ''
      const active = before.active !== after.active ? (after.active ? 'reactivated' : 'deactivated') : ''
      return { code: 'CAT', status: 'Category updated', detail: withSummary(name, [renamed, active].filter(Boolean).join(', ')), by, at }
    }
    case 'brand.create':
      return { code: 'BRND', status: 'Brand added', detail: `${text(data.name, 'A brand')}.`, by, at }
    case 'brand.update': {
      const renamed = before.name !== after.name ? `renamed from ${text(before.name, '')}` : ''
      const active = before.active !== after.active ? (after.active ? 'reactivated' : 'deactivated') : ''
      return { code: 'BRND', status: 'Brand updated', detail: withSummary(text(after.name, 'A brand'), [renamed, active].filter(Boolean).join(', ')), by, at }
    }
    case 'group.create':
      return { code: 'GRP', status: 'Group added', detail: `${text(data.name, 'A group')}.`, by, at }
    case 'group.update': {
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
      const parts: string[] = []
      if (before.name !== after.name) parts.push(`renamed from ${text(before.name, '')}`)
      if (!same(before.attributeKeys, after.attributeKeys)) parts.push('attributes changed')
      if (before.active !== after.active) parts.push(after.active ? 'reactivated' : 'deactivated')
      return { code: 'GRP', status: 'Group updated', detail: withSummary(text(after.name, 'A group'), parts.join(', ')), by, at }
    }
    case 'stock.adjust': {
      const outlet = names.outlets.get(String(data.outletId))
      const delta = typeof data.deltaMilli === 'number' ? data.deltaMilli : 0
      const qty = `${delta > 0 ? '+' : ''}${formatQty(delta)}`
      const unit = typeof data.baseUnit === 'string' ? ` ${data.baseUnit}` : ''
      const reason = ADJUST_REASON_LABELS[data.reason as AdjustReason]?.toLowerCase() ?? text(data.reason, 'no reason')
      return {
        code: outlet?.code ?? 'STK',
        status: 'Stock adjusted',
        detail: `${text(data.itemName, 'An item')} ${qty}${unit}, ${reason}.`,
        by,
        at,
      }
    }
    case 'catalog.import': {
      const n = (v: unknown) => (typeof v === 'number' ? v : 0)
      return {
        code: 'IMP',
        status: 'Catalog imported',
        detail: `${plural(n(data.itemCount), 'item')}, ${plural(n(data.packCount), 'pack')}, ${plural(n(data.stockCells), 'opening stock entry', 'opening stock entries')}.`,
        by,
        at,
      }
    }
    default:
      return null
  }
}

/** Confirmation line for till and order audit actions; null for any other action. */
function tillConfirmation(e: ActivityEntry, data: Record<string, unknown>): Confirmation | null {
  const by = e.actorName
  const at = e.at
  const number = text(data.number, 'ORDER')
  const kes = (v: unknown) => (typeof v === 'number' ? formatKes(v) : '')
  switch (e.action) {
    case 'device.register':
      return { code: `${text(data.outletCode, '')}-${text(data.code, '')}`, status: 'Till set up', detail: `${text(data.name, 'A till')}.`, by, at }
    case 'device.revoke':
      return { code: `TILL-${text(data.code, '')}`, status: 'Till revoked', detail: `${text(data.name, 'A till')} can no longer sync.`, by, at }
    case 'order.mark_paid':
      return { code: number, status: 'Marked paid', tone: 'paid', detail: `${kes(data.amountCents)}. ${e.reason ?? ''}`.trim(), by, at }
    case 'order.credit':
      return { code: number, status: 'Credit approved', tone: 'credit', detail: `${kes(data.creditCents)} of goods taken before payment.`, by, at }
    case 'order.price_override':
      return {
        code: number,
        status: 'Price below lowest',
        tone: 'owed',
        detail: `${text(data.itemName, 'An item')} at ${kes(data.unitPriceCents)} (lowest ${kes(data.floorCents)}).`,
        by,
        at,
      }
    case 'order.over_collected':
      return { code: number, status: 'Collected beyond paid', tone: 'credit', detail: 'Two tills handed over goods against the same payment. Check the order.', by, at }
    case 'order.cancel_remainder':
      return { code: number, status: 'Remainder cancelled', tone: 'owed', detail: `${e.reason ?? ''}`, by, at }
    case 'order.refund':
      return { code: number, status: 'Refunded', tone: 'owed', detail: `${kes(data.amountCents)}. ${e.reason ?? ''}`.trim(), by, at }
    default:
      return null
  }
}

/** Turns an audit row into a confirmation line: code first, then what happened. */
export function toConfirmation(e: ActivityEntry, names: Names): Confirmation {
  const data = rec(e.data)
  const by = e.actorName
  const at = e.at

  const catalog = catalogConfirmation(e, data, names) ?? tillConfirmation(e, data)
  if (catalog) return catalog

  if (e.entityType === 'outlet') {
    const o = names.outlets.get(e.entityId)
    const code = o?.code ?? String(data.code ?? 'OUTLET')
    const name = o?.name ?? String(data.name ?? '')
    if (e.action === 'outlet.create') {
      return { code, status: 'Outlet opened', detail: `${name}, ${modeLabel(data.connectionMode)} mode.`, by, at }
    }
    const before = rec(data.before)
    const after = rec(data.after)
    const changes: string[] = []
    if (before.name !== after.name) changes.push(`renamed to ${String(after.name)}`)
    if (before.connectionMode !== after.connectionMode)
      changes.push(`connection mode set to ${modeLabel(after.connectionMode)}`)
    if (before.active !== after.active) changes.push(after.active ? 'reopened' : 'closed')
    return {
      code,
      status: 'Outlet updated',
      detail: `${name}${changes.length ? `: ${changes.join(', ')}` : ''}.`,
      by,
      at,
    }
  }

  if (e.entityType === 'membership') {
    const person = names.staff.get(e.entityId) ?? String(data.name ?? 'A staff member')
    const code = initials(person)
    switch (e.action) {
      case 'staff.create':
        return {
          code,
          status: 'Staff added',
          detail: `${person} as ${ROLE_LABELS[data.role as Role] ?? String(data.role)}.`,
          by,
          at,
        }
      case 'staff.set_pin':
        return { code, status: 'Till PIN set', detail: `for ${person}.`, by, at }
      case 'staff.set_own_pin':
        return { code, status: 'Till PIN chosen', detail: `by ${person} at first sign-in on a till.`, by, at }
      case 'staff.deactivate':
        return { code, status: 'Staff deactivated', detail: `${person} can no longer sign in.`, by, at }
      case 'staff.reactivate':
        return { code, status: 'Staff reactivated', detail: `${person}.`, by, at }
      default: {
        const after = rec(data.after)
        return {
          code,
          status: 'Staff updated',
          detail: `${person}${after.role ? `, now ${ROLE_LABELS[after.role as Role] ?? String(after.role)}` : ''}.`,
          by,
          at,
        }
      }
    }
  }

  if (e.action === 'business.default_mode') {
    return {
      code: 'ALL',
      status: 'Default mode changed',
      detail: `${modeLabel(data.before)} to ${modeLabel(data.after)} for every outlet without its own.`,
      by,
      at,
    }
  }

  return { code: e.entityType.slice(0, 4).toUpperCase(), status: e.action, by, at }
}
