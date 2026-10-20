import { db } from '@/db/client'
import { toCsv } from '@/domain/csv'
import { isUuid } from '@/domain/ids'
import { can } from '@/domain/permissions'
import { getCurrentUser } from '@/server/auth/current-user'
import { DomainError } from '@/server/errors'
import { getTenantCtx } from '@/server/tenant'
import { isReportKey, rangeFrom, reportTable } from '../report-data'

/** One report as CSV: /admin/reports/export?report=sales_by_day&from=2026-10-01&to=2026-10-20&outlet=… */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const user = await getCurrentUser()
  const ctx = user && !user.mustChangePassword ? await getTenantCtx(db, user.id) : null
  if (!ctx || !can(ctx.role, 'report.view')) return new Response('Sign in as an owner or manager.', { status: 403 })
  const key = url.searchParams.get('report') ?? ''
  if (!isReportKey(key)) return new Response('Unknown report.', { status: 404 })
  const outlet = url.searchParams.get('outlet') ?? ''
  const { range, from, to } = rangeFrom(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '')
  try {
    const t = await reportTable(db, ctx, key, range, { outletId: isUuid(outlet) ? outlet : null })
    // Cells starting with = + - @ are quoted with a leading apostrophe so spreadsheets never run them.
    const safe = (c: string) => (/^[=+\-@]/.test(c) && !/^-?[\d,.]+$/.test(c) ? `'${c}` : c)
    const csv = toCsv([t.header, ...t.rows.map((r) => r.map(safe))])
    return new Response('﻿' + csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${key}_${from}_${to}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    if (e instanceof DomainError) return new Response(e.message, { status: e.code === 'forbidden' ? 403 : 404 })
    throw e
  }
}
