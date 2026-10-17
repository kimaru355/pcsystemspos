import { LogOut } from 'lucide-react'
import { logout } from '@/app/logout/actions'
import { MobileNav } from './mobile-nav'
import { RailNav } from './nav-link'
import type { NavKey } from './nav-config'
import { Wordmark } from './wordmark'

function Account({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-t border-sidebar-border pt-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-rail-ink">{name}</p>
        <p className="truncate text-xs text-rail-muted">{detail}</p>
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-rail-muted hover:bg-rail-raised hover:text-rail-ink focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
        >
          <LogOut aria-hidden className="size-4" />
          Log out
        </button>
      </form>
    </div>
  )
}

/**
 * The admin and platform frame: a night-blue rail on the left (a sheet on phones),
 * a light top bar for scope and quick actions, and one work area.
 */
export function AppShell({
  nav,
  context,
  account,
  toolbar,
  children,
}: {
  nav: NavKey
  /** The business (or "Platform") the rail is for. */
  context: string
  account: { name: string; detail: string }
  toolbar?: React.ReactNode
  children: React.ReactNode
}) {
  const accountBlock = <Account {...account} />
  return (
    <div className="flex min-h-dvh flex-1">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 overflow-y-auto bg-rail px-3 py-4 text-rail-ink md:flex">
        <div className="flex flex-col gap-1 px-3">
          <Wordmark />
          <p className="truncate text-sm text-rail-muted">{context}</p>
        </div>
        <RailNav nav={nav} />
        <div className="mt-auto">{accountBlock}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-rule bg-background/95 px-4 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80 md:px-8">
          <MobileNav nav={nav} footer={accountBlock} />
          <p className="min-w-0 truncate text-sm font-semibold md:hidden">{context}</p>
          <div className="ml-auto flex items-center gap-2">{toolbar}</div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  )
}
