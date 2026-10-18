import { describe, expect, it } from 'vitest'
import { can, type Action, type Role } from '@/domain/permissions'

const matrix: Record<Role, Record<Action, boolean>> = {
  owner: {
    'business.settings': true,
    'outlet.manage': true,
    'staff.manage': true,
    'staff.reset_pin': true,
    'catalog.manage': true,
    'stock.receive': true,
    'stock.adjust': true,
    'stock.view': true,
    'device.manage': true,
    'order.sell': true,
    'order.approve': true,
    'order.view': true,
    'order.cancel': true,
  },
  manager: {
    'business.settings': false,
    'outlet.manage': false,
    'staff.manage': false,
    'staff.reset_pin': true,
    'catalog.manage': false,
    'stock.receive': true,
    'stock.adjust': true,
    'stock.view': true,
    'device.manage': true,
    'order.sell': true,
    'order.approve': true,
    'order.view': true,
    'order.cancel': true,
  },
  cashier: {
    'business.settings': false,
    'outlet.manage': false,
    'staff.manage': false,
    'staff.reset_pin': false,
    'catalog.manage': false,
    'stock.receive': false,
    'stock.adjust': false,
    'stock.view': true,
    'device.manage': false,
    'order.sell': true,
    'order.approve': false,
    'order.view': false,
    'order.cancel': false,
  },
}

const cases = (Object.keys(matrix) as Role[]).flatMap((role) =>
  (Object.keys(matrix[role]) as Action[]).map((action) => [role, action, matrix[role][action]] as const),
)

describe('can', () => {
  it.each(cases)('%s / %s -> %s', (role, action, expected) => {
    expect(can(role, action)).toBe(expected)
  })
})
