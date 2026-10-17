export type Role = 'owner' | 'manager' | 'cashier'

export const ROLES: readonly Role[] = ['owner', 'manager', 'cashier']

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
}

/** Later phases extend this union. */
export type Action =
  | 'business.settings'
  | 'outlet.manage'
  | 'staff.manage'
  | 'staff.reset_pin'
  | 'catalog.manage'
  | 'stock.receive'
  | 'stock.adjust'
  | 'stock.view'

const MANAGER_ACTIONS: readonly Action[] = [
  'staff.reset_pin',
  'stock.receive',
  'stock.adjust',
  'stock.view',
]

const CASHIER_ACTIONS: readonly Action[] = ['stock.view']

/** Role-level check only. Outlet scope is enforced separately by the services. */
export function can(role: Role, action: Action): boolean {
  if (role === 'owner') return true
  if (role === 'manager') return MANAGER_ACTIONS.includes(action)
  return CASHIER_ACTIONS.includes(action)
}
