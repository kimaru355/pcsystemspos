import { Suspense } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { ConfirmationLine } from '@/components/shell/confirmation-line'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { AUDIT_GROUPS, listAudit, listRejectedOps, type AuditGroup } from '@/server/services/audit-log'
import { listOutlets } from '@/server/services/outlets'
import { listStaff } from '@/server/services/staff'
import { requireTenant } from '@/server/tenant'
import { toConfirmation } from '../activity-lines'
import { inputClass } from '../_forms/styles'
import { nairobiDay } from '../reports/report-data'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

const GROUP_LABELS: Record<AuditGroup, string> = {
  orders: 'Orders and receipts',
  payments: 'Payments',
  stock: 'Stock',
  staff: 'Staff',
  tills: 'Tills',
  catalog: 'Catalog',
  settings: 'Outlets and settings',
}

const OP_LABELS: Record<string, string> = {
  'sale.checkout': 'Sale',
  'payment.add': 'Payment',
  'collection.record': 'Collection',
  'stock.adjust': 'Stock adjustment',
  'receipt.send': 'Receipt by SMS or email',
}

const when = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' })

export default function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Audit log" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <AuditContent searchParams={searchParams} />
    </Suspense>
  )
}

async function AuditContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const ctx = await requireTenant()
  if (!can(ctx.role, 'audit.view')) {
    return (
      <>
        <PageHeader title="Audit log" />
        <p className="text-sm text-muted-foreground">Only the owner sees the audit log.</p>
      </>
    )
  }
  const groupParam = one(params.group)
  const group = Object.hasOwn(AUDIT_GROUPS, groupParam) ? (groupParam as AuditGroup) : undefined
  const fromDay = nairobiDay(one(params.from))
  const toDay = nairobiDay(one(params.to))
  const before = Number(one(params.before))
  const [rows, rejected, outlets, staff] = await Promise.all([
    listAudit(db, ctx, {
      group,
      from: fromDay ?? undefined,
      to: toDay ? new Date(toDay.getTime() + 24 * 60 * 60 * 1000) : undefined,
      beforeSeq: Number.isSafeInteger(before) && before > 0 ? before : undefined,
    }),
    listRejectedOps(db, ctx),
    listOutlets(db, ctx),
    listStaff(db, ctx),
  ])
  const names = {
    outlets: new Map(outlets.map((o) => [o.id, { code: o.code, name: o.name }])),
    staff: new Map(staff.map((s) => [s.membershipId, s.name])),
  }
  const keep = new URLSearchParams({
    ...(group ? { group } : {}),
    ...(fromDay ? { from: one(params.from) } : {}),
    ...(toDay ? { to: one(params.to) } : {}),
  })
  const last = rows.at(-1)

  return (
    <>
      <PageHeader title="Audit log" description="Who did what, and when: approvals, payments marked paid, price overrides, stock changes, cancellations, tills and settings." />
      <form method="get" className="grid gap-3 pb-6 sm:grid-cols-[14rem_10rem_10rem_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-group" className="text-sm font-medium">
            Show
          </label>
          <select id="audit-group" name="group" defaultValue={group ?? ''} className={inputClass}>
            <option value="">Everything</option>
            {(Object.keys(GROUP_LABELS) as AuditGroup[]).map((g) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-from" className="text-sm font-medium">
            From
          </label>
          <input id="audit-from" type="date" name="from" defaultValue={one(params.from)} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-to" className="text-sm font-medium">
            To
          </label>
          <input id="audit-to" type="date" name="to" defaultValue={one(params.to)} className={inputClass} />
        </div>
        <Button type="submit" variant="outline" size="lg">
          Show
        </Button>
      </form>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Region id="audit-heading" title="Actions">
          {rows.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">Nothing recorded for this filter.</p>
          ) : (
            <ol className="divide-y divide-rule">
              {rows.map((r) => {
                const c = toConfirmation(r, names)
                const extra = [r.action, r.tillCode ? `on till ${r.tillCode}` : null, r.occurredAt ? `happened ${when.format(r.occurredAt)}` : null]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <ConfirmationLine
                    key={r.id}
                    c={{ ...c, detail: <>{c.detail} <span className="text-xs text-muted-foreground">{extra}</span></> }}
                  />
                )
              })}
            </ol>
          )}
          {last && rows.length >= 100 && (
            <Link href={`/admin/audit?${keep}&before=${last.seq}`} className="mt-3 inline-block text-sm text-primary underline-offset-4 hover:underline">
              Older
            </Link>
          )}
        </Region>
        <Region id="rejected-heading" title="Refused from tills" size="sm">
          <p className="pb-2 text-sm text-muted-foreground">
            Things recorded on a till that the server did not accept. Nothing was lost: the details are kept here.
          </p>
          {rejected.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y divide-rule text-sm">
              {rejected.map((r) => (
                <li key={r.id} className="py-2">
                  <p>
                    <span className="font-mono text-[0.8rem] font-medium">{r.tillCode}</span> {OP_LABELS[r.type] ?? r.type}
                    {r.actorName && <span className="text-muted-foreground"> by {r.actorName}</span>}
                    <span className="text-xs text-muted-foreground"> · {when.format(r.receivedAt)}</span>
                  </p>
                  <p className="text-xs text-credit">{r.errorMessage}</p>
                  <details className="text-xs">
                    <summary className="cursor-pointer text-primary">Details</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2">{JSON.stringify(r.payload, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Region>
      </div>
    </>
  )
}
