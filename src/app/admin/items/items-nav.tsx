import Link from 'next/link'

const LINKS = [
  { key: 'items', href: '/admin/items', label: 'Items' },
  { key: 'categories', href: '/admin/items/categories', label: 'Categories' },
  { key: 'brands', href: '/admin/items/brands', label: 'Brands' },
  { key: 'groups', href: '/admin/items/groups', label: 'Groups' },
] as const

export type ItemsNavKey = (typeof LINKS)[number]['key']

/** Hops between the item list and its taxonomy screens. */
export function ItemsNav({ current }: { current: ItemsNavKey | null }) {
  return (
    <nav aria-label="Catalog" className="flex flex-wrap gap-x-4 gap-y-1 pb-6 text-sm">
      {LINKS.map((l) =>
        l.key === current ? (
          <span key={l.key} aria-current="page" className="font-semibold">
            {l.label}
          </span>
        ) : (
          <Link key={l.key} href={l.href} className="text-primary underline-offset-4 hover:underline">
            {l.label}
          </Link>
        ),
      )}
    </nav>
  )
}
