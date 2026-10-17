import { NextResponse } from 'next/server'
import { db } from '@/db/client'
import { importTemplateCsv } from '@/domain/catalog-import'
import { can } from '@/domain/permissions'
import { getCurrentUser } from '@/server/auth/current-user'
import { listOutlets } from '@/server/services/outlets'
import { getTenantCtx } from '@/server/tenant'

/** The import template: owners only. Not signed in is 401; a signed-in non-owner is 403. */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return new NextResponse('Sign in first.', { status: 401 })
  const ctx = await getTenantCtx(db, user.id)
  if (!ctx || !can(ctx.role, 'catalog.manage')) return new NextResponse('Only owners can do that.', { status: 403 })

  const codes = (await listOutlets(db, ctx)).filter((o) => o.active).map((o) => o.code)
  return new NextResponse(importTemplateCsv(codes), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="items-template.csv"',
      'Cache-Control': 'private, no-store',
    },
  })
}
