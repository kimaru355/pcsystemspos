'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from 'cn'
import { NAV, type NavKey } from './nav-config'

function isActive(pathname: string, href: string, root: string) {
  return href === root ? pathname === root : pathname === href || pathname.startsWith(`${href}/`)
}

export function RailNav({ nav, onNavigate }: { nav: NavKey; onNavigate?: () => void }) {
  const pathname = usePathname()
  const { groups, root, label } = NAV[nav]
  return (
    <nav aria-label={label} className="flex flex-col gap-5">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-0.5">
          <h2 className="px-3 pb-1 text-[0.7rem] font-medium tracking-wide text-rail-muted uppercase">
            {g.label}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((item) => {
              const Icon = item.icon
              if (item.soon) {
                return (
                  <li key={item.href}>
                    <span
                      aria-disabled="true"
                      className="flex h-9 items-center gap-3 rounded-md px-3 text-sm text-rail-muted/70"
                    >
                      <Icon aria-hidden className="size-4" />
                      {item.label}
                      <span className="ml-auto text-[0.7rem]">Soon</span>
                    </span>
                  </li>
                )
              }
              const active = isActive(pathname, item.href, root)
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                      active
                        ? 'bg-rail-raised font-medium text-rail-ink'
                        : 'text-rail-muted hover:bg-rail-raised/60 hover:text-rail-ink',
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
