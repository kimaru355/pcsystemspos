import { MODE_LABELS, type ConnectionMode } from '@/domain/connection-modes'
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

/** Turns an audit row into a confirmation line: code first, then what happened. */
export function toConfirmation(e: ActivityEntry, names: Names): Confirmation {
  const data = rec(e.data)
  const by = e.actorName
  const at = e.at

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
