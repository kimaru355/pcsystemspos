'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { MAX_IMPORT_BYTES } from '@/domain/catalog-import'
import { Field } from '../../_forms/form-kit'
import { applyImportAction, previewImportAction } from './actions'
import { ERROR_LIST_CAP, initialApply, initialPreview, type ApplyState, type PreviewState } from './import-state'

function count(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString('en-KE')} ${n === 1 ? one : many}`
}

function NameList({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{names.join(', ')}</dd>
    </div>
  )
}

export function ImportForm({ outletCodes }: { outletCodes: string[] }) {
  const [preview, previewAction, checking] = useActionState<PreviewState, FormData>(
    // A client wrapper, so the previous state (which holds the whole file) is not posted back each time.
    (_prev, formData) => previewImportAction(formData),
    initialPreview,
  )
  const [applied, applyAction, applying] = useActionState<ApplyState, FormData>(applyImportAction, initialApply)
  const [tooBig, setTooBig] = useState<string | null>(null)

  const p = preview.preview
  const errorCount = preview.errorCount ?? 0
  const mine = applied.forPreview !== undefined && applied.forPreview === preview.nonce
  const finished = mine && applied.ok === true && applied.result !== undefined
  const canImport = p !== undefined && errorCount === 0 && p.rowCount > 0 && !finished

  return (
    <div className="flex flex-col gap-8">
      <form action={previewAction} className="flex flex-col gap-3" noValidate>
        <Field
          id="import-file"
          label="CSV file"
          hint={`Up to 2 MB and 5,000 rows. Opening stock goes in ${outletCodes.length > 0 ? outletCodes.map((c) => `stock_${c}`).join(', ') : 'a stock_ column per outlet'}.`}
          error={tooBig ?? undefined}
        >
          {(f) => (
            <input
              {...f}
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              disabled={applying}
              onChange={(e) => {
                const file = e.target.files?.[0]
                setTooBig(
                  file && file.size > MAX_IMPORT_BYTES
                    ? `That file is ${(file.size / 1_000_000).toFixed(1)} MB. The limit is 2 MB.`
                    : null,
                )
              }}
              className={`${f.className} h-auto py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-sm file:font-medium`}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg" disabled={checking || applying || tooBig !== null}>
            {checking ? 'Checking…' : 'Check file'}
          </Button>
          <p aria-live="polite" className="min-h-5 text-sm text-destructive">
            {preview.message}
          </p>
        </div>
      </form>

      {p && (
        <section aria-labelledby="preview-heading" className="flex flex-col gap-4 border-t border-foreground/80 pt-3">
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="preview-heading" className="text-lg font-semibold">
              {errorCount === 0 ? 'Ready to import' : 'Fix these first'}
            </h2>
            {preview.fileName && <span className="truncate font-mono text-xs text-muted-foreground">{preview.fileName}</span>}
          </div>

          <p className="figures text-sm">
            {count(p.itemCount, 'item')}, {count(p.packCount, 'pack')}, {count(p.stockCells, 'opening stock row')}.
            {errorCount > 0 && (
              <>
                {' '}
                <span className="font-medium text-destructive">{count(errorCount, 'error')}</span> in the file.
              </>
            )}
          </p>

          <dl className="flex flex-col gap-3">
            <NameList label="New categories" names={p.newCategories} />
            <NameList label="New brands" names={p.newBrands} />
            <NameList label="New groups" names={p.newGroups} />
          </dl>

          {errorCount > 0 && (
            <div>
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Errors found in the file</caption>
                <thead>
                  <tr className="border-b border-rule text-xs font-medium text-muted-foreground">
                    <th scope="col" className="w-20 py-1.5 pr-3 font-medium">
                      Row
                    </th>
                    <th scope="col" className="w-36 py-1.5 pr-3 font-medium">
                      Column
                    </th>
                    <th scope="col" className="py-1.5 font-medium">
                      Problem
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {p.errors.map((e, i) => (
                    <tr key={i} className="border-b border-rule align-baseline">
                      <td className="figures py-1.5 pr-3">{e.line === null ? '' : `Row ${e.line}`}</td>
                      <td className="py-1.5 pr-3 font-mono text-[0.8rem]">{e.column ?? ''}</td>
                      <td className="py-1.5 break-words">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {errorCount > p.errors.length && (
                <p className="py-2 text-sm text-muted-foreground">
                  Showing the first {ERROR_LIST_CAP} of {errorCount.toLocaleString('en-KE')}. Fix these and check the file again.
                </p>
              )}
              <p className="py-2 text-sm text-muted-foreground">
                Row numbers count records in the file, with the header as row 1.
              </p>
            </div>
          )}

          {errorCount === 0 && p.rowCount === 0 && (
            <p className="text-sm text-muted-foreground">The file has no item rows, so there is nothing to import.</p>
          )}

          <form action={applyAction} className="flex flex-col gap-2">
            <input type="hidden" name="csv" value={preview.csv ?? ''} />
            <input type="hidden" name="previewNonce" value={preview.nonce ?? ''} />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="lg" disabled={!canImport || applying || checking}>
                {applying ? 'Importing…' : finished ? 'Imported' : `Import ${count(p.rowCount, 'item')}`}
              </Button>
              {applying && (
                <span className="text-sm text-muted-foreground">
                  Importing. A large file can take up to a minute. Keep this page open.
                </span>
              )}
            </div>
            <p aria-live="polite" className="min-h-5 text-sm text-destructive">
              {mine && !applied.ok ? applied.message : ''}
            </p>
          </form>
        </section>
      )}

      {finished && applied.result && (
        <p role="status" className="figures text-sm">
          <span className="font-semibold">Imported.</span> {count(applied.result.itemCount, 'item')},{' '}
          {count(applied.result.packCount, 'pack')}, {count(applied.result.stockCells, 'opening stock row')}.{' '}
          <Link href="/admin/items" className="text-primary underline-offset-4 hover:underline">
            View items
          </Link>
        </p>
      )}
    </div>
  )
}
