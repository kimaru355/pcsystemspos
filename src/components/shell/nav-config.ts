import {
  Activity,
  Banknote,
  Boxes,
  Building2,
  ChartColumn,
  LayoutDashboard,
  Package,
  ReceiptText,
  ScrollText,
  Settings,
  ShieldCheck,
  Smartphone,
  Store,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react'

export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
  /** Not built yet: shown so the shape of the product is visible, but not a link. */
  soon?: boolean
}

export type NavGroup = { label: string; items: NavItem[] }

export type NavKey = 'admin' | 'platform'

export const NAV: Record<NavKey, { root: string; label: string; groups: NavGroup[] }> = {
  admin: {
    root: '/admin',
    label: 'Admin',
    groups: [
      {
        label: 'Daily',
        items: [
          { href: '/admin', label: 'Overview', icon: LayoutDashboard },
          { href: '/admin/orders', label: 'Orders', icon: ReceiptText },
          { href: '/admin/payments', label: 'Payments', icon: Banknote },
          { href: '/admin/customers', label: 'Customers', icon: Users, soon: true },
        ],
      },
      {
        label: 'Stock',
        items: [
          { href: '/admin/items', label: 'Items', icon: Package },
          { href: '/admin/stock', label: 'Stock', icon: Boxes },
        ],
      },
      {
        label: 'Business',
        items: [
          { href: '/admin/outlets', label: 'Outlets', icon: Store },
          { href: '/admin/staff', label: 'Staff', icon: UserCog },
          { href: '/admin/devices', label: 'Tills', icon: Smartphone },
          { href: '/admin/reports', label: 'Reports', icon: ChartColumn, soon: true },
          { href: '/admin/audit', label: 'Audit log', icon: ScrollText, soon: true },
          { href: '/admin/settings', label: 'Settings', icon: Settings },
        ],
      },
    ],
  },
  platform: {
    root: '/platform',
    label: 'Platform',
    groups: [
      {
        label: 'Platform',
        items: [
          { href: '/platform', label: 'Businesses', icon: Building2 },
          { href: '/platform/health', label: 'Health', icon: Activity, soon: true },
          { href: '/platform/support', label: 'Support access', icon: ShieldCheck, soon: true },
        ],
      },
    ],
  },
}
