import { Suspense } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { listOutlets } from '@/server/services/outlets'
import { requireTenant } from '@/server/tenant'
import { ItemsNav } from '../items-nav'
import { ImportForm } from './import-form'

export default function ImportPage() {
  return (
    <>
      <PageHeader title="Import items" description="Add many items at once from a CSV file, with their packs, barcodes and opening stock." />
      <ItemsNav current={null} />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ImportContent />
      </Suspense>
    </>
  )
}

async function ImportContent() {
  const ctx = await requireTenant()
  if (!can(ctx.role, 'catalog.manage')) {
    return (
      <p className="text-sm text-muted-foreground">
        Only owners can import items.{' '}
        <Link href="/admin/items" className="text-primary underline-offset-4 hover:underline">
          Back to items
        </Link>
      </p>
    )
  }
  const outletCodes = (await listOutlets(db, ctx)).filter((o) => o.active).map((o) => o.code)

  return (
    <div className="flex flex-col gap-10">
      <Region id="template-heading" title="1. Get the template">
        <p className="max-w-[65ch] pb-3 text-sm text-muted-foreground">
          One row per item. The template has every column and an example row
          {outletCodes.length > 0 ? `, plus an opening-stock column for each outlet (${outletCodes.map((c) => `stock_${c}`).join(', ')})` : ''}.
          Items that already exist are not updated: a SKU or barcode already in use is an error.
        </p>
        {/* A plain link: this is a file download, not a page to prefetch. */}
        <a
          href="/admin/items/import/template"
          download="items-template.csv"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Download items-template.csv
        </a>
      </Region>
      <Region id="upload-heading" title="2. Check your file">
        <ImportForm outletCodes={outletCodes} />
      </Region>
    </div>
  )
}
