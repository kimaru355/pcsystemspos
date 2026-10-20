import { Suspense } from 'react'
import Link from 'next/link'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { isUuid } from '@/domain/ids'
import { listOutlets } from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'
import { inputClass } from '../_forms/styles'
import { REPORTS, rangeFrom, reportTable, type ReportKey } from './report-data'

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

export default function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Reports" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <ReportsContent searchParams={searchParams} />
    </Suspense>
  )
}

const SHOWN_ROWS = 50

async function ReportsContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const ctx = await requireTenant()
  const outlets = (await listOutlets(db, ctx)).filter((o) => o.active)
  const outletParam = one(params.outlet)
  const outletId = isUuid(outletParam) && outlets.some((o) => o.id === outletParam) ? outletParam : null
  const { range, from, to } = rangeFrom(one(params.from), one(params.to))
  const keys = Object.keys(REPORTS) as ReportKey[]
  const tables = await Promise.all(keys.map((k) => reportTable(db, ctx, k, range, { outletId })))
  const qs = new URLSearchParams({ from, to, ...(outletId ? { outlet: outletId } : {}) })

  return (
    <>
      <PageHeader title="Reports" description="Sales, payments and stock for a period. Each table downloads as CSV for a spreadsheet." />
      <form method="get" className="grid gap-3 pb-8 sm:grid-cols-[10rem_10rem_minmax(0,14rem)_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rep-from" className="text-sm font-medium">
            From
          </label>
          <input id="rep-from" type="date" name="from" defaultValue={from} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rep-to" className="text-sm font-medium">
            To
          </label>
          <input id="rep-to" type="date" name="to" defaultValue={to} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rep-outlet" className="text-sm font-medium">
            Outlet
          </label>
          <select id="rep-outlet" name="outlet" defaultValue={outletId ?? ''} className={inputClass}>
            <option value="">{ctx.outletScope === 'all' ? 'All outlets' : 'All my outlets'}</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.code} · {o.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" size="lg">
          Show
        </Button>
      </form>

      <div className="grid gap-10 xl:grid-cols-2">
        {keys.map((k, i) => {
          const t = tables[i]
          return (
            <Region
              key={k}
              id={`${k}-heading`}
              title={REPORTS[k]}
              aside={
                <Link href={`/admin/reports/export?report=${k}&${qs}`} prefetch={false} className="text-xs text-primary underline-offset-4 hover:underline">
                  Download CSV
                </Link>
              }
            >
              {t.rows.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">Nothing in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-rule text-xs text-muted-foreground">
                        {t.header.map((h, j) => (
                          <th key={h} className={cn('py-1.5 pr-3 font-medium', t.numeric[j] ? 'text-right' : 'text-left')}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {t.rows.slice(0, SHOWN_ROWS).map((r, ri) => (
                        <tr key={ri} className="border-b border-rule">
                          {r.map((c, j) => (
                            <td key={j} className={cn('py-1.5 pr-3', t.numeric[j] && 'figures text-right')}>
                              {c}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {t.rows.length > SHOWN_ROWS && (
                    <p className="py-2 text-xs text-muted-foreground">Showing {SHOWN_ROWS} of {t.rows.length}. The CSV has them all.</p>
                  )}
                </div>
              )}
            </Region>
          )
        })}
      </div>
    </>
  )
}
