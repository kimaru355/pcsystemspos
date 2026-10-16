export type Role = 'owner' | 'manager' | 'cashier'

/** Later phases extend this union. */
export type Action = 'business.settings' | 'outlet.manage' | 'staff.manage' | 'staff.reset_pin'

const MANAGER_ACTIONS: readonly Action[] = ['staff.reset_pin']

export function can(role: Role, action: Action): boolean {
  if (role === 'owner') return true
  if (role === 'manager') return MANAGER_ACTIONS.includes(action)
  return false
}
