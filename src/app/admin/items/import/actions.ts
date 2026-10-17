'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { MAX_IMPORT_BYTES } from '@/domain/catalog-import'
import { applyImport, previewImport } from '@/server/services/catalog-import'
import { requireTenant } from '@/server/tenant'
import { failure } from '../../_forms/form-state'
import { ERROR_LIST_CAP, rowWording, type ApplyState, type PreviewState } from './import-state'

const TOO_LARGE = (bytes: number) =>
  `That file is ${(bytes / 1_000_000).toFixed(1)} MB. The limit is 2 MB. Split it into smaller files.`

const nonce = () => crypto.randomUUID()

/**
 * Takes the form data alone (no previous state): the client keeps the preview, which carries the
 * file's text, and `useActionState` would post that state back with every call.
 */
export async function previewImportAction(formData: FormData): Promise<PreviewState> {
  const ctx = await requireTenant()
  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { message: 'Choose a CSV file to check.', nonce: nonce() }
  }
  if (file.size > MAX_IMPORT_BYTES) return { message: TOO_LARGE(file.size), nonce: nonce() }
  try {
    const csv = await file.text()
    const preview = await previewImport(db, ctx, csv)
    return {
      message: '',
      ok: true,
      nonce: nonce(),
      preview: {
        ...preview,
        errors: preview.errors.slice(0, ERROR_LIST_CAP).map((e) => ({ ...e, message: rowWording(e.message) })),
      },
      errorCount: preview.errors.length,
      csv,
      fileName: file.name,
    }
  } catch (e) {
    const { message } = failure(e, 'Nothing to import.', formData, ['file'])
    return { message, nonce: nonce() }
  }
}

export async function applyImportAction(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  const ctx = await requireTenant()
  const raw = formData.get('csv')
  // Posting a form turns every line end into CRLF; put LF back so the size and the text match the file.
  const csv = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n') : raw
  const forPreview = String(formData.get('previewNonce') ?? '')
  if (typeof csv !== 'string' || csv === '') return { message: 'Check a file first.', nonce: nonce(), forPreview }
  const bytes = new TextEncoder().encode(csv).length
  if (bytes > MAX_IMPORT_BYTES) return { message: TOO_LARGE(bytes), nonce: nonce(), forPreview }
  try {
    const result = await applyImport(db, ctx, csv, { confirmDuplicate: formData.get('confirmDuplicate') === 'yes' })
    revalidatePath('/admin/items')
    revalidatePath('/admin/stock')
    revalidatePath('/admin')
    return { message: '', ok: true, nonce: nonce(), result, forPreview }
  } catch (e) {
    const { message } = failure(e, 'Nothing to import.', formData, ['csv'])
    return { message: rowWording(message), nonce: nonce(), forPreview }
  }
}
