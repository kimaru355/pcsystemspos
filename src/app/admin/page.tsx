import { Suspense } from 'react'
import Link from 'next/link'
import { ChevronRight, Circle, CircleCheck } from 'lucide-react'
import { cn } from 'cn'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { ConfirmationThread, type Confirmation } from '@/components/shell/confirmation-line'
import { PageHeader } from '@/components/shell/page-header'
import { SettlementBar } from '@/components/shell/settlement-bar'
import { readOutletFilter } from '@/server/outlet-filter'
import { listRecentActivity } from '@/server/services/activity'
import { listOutlets } from '@/server/services/outlets'
import { listStaff } from '@/server/services/staff'
import { requireTenant } from '@/server/tenant'
import { toConfirmation } from './activity-lines'

export default function AdminOverviewPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Overview" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <OverviewContent />
    </Suspense>
  )
}

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' })
const dayLabel = new Intl.DateTimeFormat('en-KE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'Africa/Nairobi',
})

/** Unboxed region: a one-pixel rule above, the heading, then the content. */
function Region({
  id,
  title,
  aside,
  size = 'lg',
  children,
}: {
  id: string
  title: string
  aside?: React.ReactNode
  size?: 'lg' | 'sm'
  children: React.ReactNode
}) {
  return (
    <section aria-labelledby={id} className="border-t border-foreground/80 pt-3">
      <div className="flex items-baseline justify-between gap-4 pb-2">
        <h2 id={id} className={size === 'lg' ? 'text-lg font-semibold' : 'text-sm font-semibold'}>
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

async function OverviewContent() {
  const ctx = await requireTenant()
  const isOwner = can(ctx.role, 'business.settings')
  const [outlets, staff] = await Promise.all([listOutlets(db, ctx), listStaff(db, ctx)])
  const activity = await listRecentActivity(db, ctx, {
    outletIds: outlets.map((o) => o.id),
    membershipIds: staff.map((s) => s.membershipId),
  })
  const active = outlets.filter((o) => o.active)
  const filter = await readOutletFilter(active.map((o) => o.id))
  const scoped = filter === 'all' ? null : active.find((o) => o.id === filter)

  const names = {
    outlets: new Map(outlets.map((o) => [o.id, { code: o.code, name: o.name }])),
    staff: new Map(staff.map((s) => [s.membershipId, s.name])),
  }
  const today = dayKey.format(new Date())
  const days: { key: string; label: string; lines: Confirmation[] }[] = []
  for (const e of activity) {
    const key = dayKey.format(e.at)
    let day = days.at(-1)
    if (!day || day.key !== key) {
      day = { key, label: key === today ? 'Today' : dayLabel.format(e.at), lines: [] }
      days.push(day)
    }
    day.lines.push(toConfirmation(e, names))
  }

  const team = staff.filter((s) => s.active && s.membershipId !== ctx.membershipId)
  const tillStaff = team.filter((s) => s.role !== 'owner')
  const withPin = tillStaff.filter((s) => s.hasPin).length
  const steps = [
    {
      done: active.length > 0,
      label: 'Open an outlet',
      detail: active.length > 0 ? `${active.length} open` : 'Each shop gets a short code',
      href: '/admin/outlets',
    },
    {
      done: tillStaff.length > 0,
      label: 'Add till staff',
      detail: tillStaff.length > 0 ? `${tillStaff.length} on the team` : 'Cashiers and managers',
      href: '/admin/staff',
    },
    {
      done: tillStaff.length > 0 && withPin === tillStaff.length,
      label: 'Set till PINs',
      detail: tillStaff.length > 0 ? `${withPin} of ${tillStaff.length} set` : 'After adding staff',
      href: '/admin/staff',
    },
    { done: false, label: 'Add items and prices', detail: 'Coming next', href: null },
  ]
  const remaining = steps.filter((s) => !s.done).length

  const scopeLabel = scoped
    ? `${scoped.code} · ${scoped.name}`
    : ctx.outletScope === 'all'
      ? 'All outlets'
      : 'All your outlets'

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <>
            Showing <span className="font-medium text-foreground">{scopeLabel}</span>. Change it from the
            outlet menu at the top.
          </>
        }
      />

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Region
          id="activity-heading"
          title="Activity"
          aside={<span className="text-xs text-muted-foreground">Who did what, latest first</span>}
        >
          {days.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              Nothing yet. Every change to outlets, staff and PINs is confirmed here with who did it, and
              sales, payments and collections will join it.
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              {days.map((d) => (
                <div key={d.key}>
                  <h3 className="border-b border-rule pb-1.5 text-xs font-medium text-muted-foreground">{d.label}</h3>
                  <ConfirmationThread items={d.lines} label={`Activity, ${d.label}`} />
                </div>
              ))}
            </div>
          )}
        </Region>

        <div className="flex flex-col gap-10">
          <Region id="money-heading" title="Money and goods today">
            <SettlementBar total={0} paid={0} collected={0} />
            <p className="text-sm text-foreground">No sales yet today.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Once the till takes orders, this shows what was paid, what customers collected and what is
              still owed across {scoped ? scoped.name : 'your outlets'}.
            </p>
          </Region>

          {isOwner && (
            <Region
              id="setup-heading"
              title="Getting ready to sell"
              size="sm"
              aside={
                <span className="text-xs text-muted-foreground">
                  {remaining === 0 ? 'All done' : `${remaining} to go`}
                </span>
              }
            >
              <ol className="flex flex-col">
                {steps.map((s) => {
                  const Icon = s.done ? CircleCheck : Circle
                  const body = (
                    <>
                      <Icon
                        aria-hidden
                        className={cn('size-4 shrink-0', s.done ? 'text-foreground' : 'text-input')}
                      />
                      <span className="min-w-0 flex-1">
                        <span className={cn('text-sm', s.done ? 'text-muted-foreground' : 'font-medium')}>
                          {s.label}
                          <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">{s.detail}</span>
                      </span>
                    </>
                  )
                  return (
                    <li key={s.label}>
                      {s.href ? (
                        <Link
                          href={s.href}
                          className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {body}
                          <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                        </Link>
                      ) : (
                        <div className="-mx-2 flex items-center gap-3 px-2 py-1.5">{body}</div>
                      )}
                    </li>
                  )
                })}
              </ol>
            </Region>
          )}

          <Region id="outlets-heading" title={ctx.outletScope === 'all' ? 'Outlets' : 'Your outlets'} size="sm">
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {isOwner ? 'No outlets yet.' : 'You are not assigned to an outlet yet. Ask the owner.'}
              </p>
            ) : (
              <ul className="divide-y divide-rule">
                {active.map((o) => (
                  <li
                    key={o.id}
                    className={cn(
                      'flex items-baseline gap-3 py-1.5 text-sm',
                      scoped && scoped.id !== o.id && 'text-muted-foreground',
                    )}
                  >
                    <span className="w-14 font-mono text-[0.8rem] font-medium">{o.code}</span>
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </Region>
        </div>
      </div>
    </>
  )
}
