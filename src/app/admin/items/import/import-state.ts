import type { FormState } from '../../_forms/form-state'
import type { ImportPreview, ImportResult } from '@/server/services/catalog-import'

/** Most errors the screen lists; the count shown is always the full count. */
export const ERROR_LIST_CAP = 200

export interface PreviewState extends FormState {
  preview?: ImportPreview
  /** Total errors in the file (`preview.errors` is capped). */
  errorCount?: number
  /** The file's text, posted back on confirm so the file is checked again as it is applied. */
  csv?: string
  fileName?: string
}

export interface ApplyState extends FormState {
  result?: ImportResult
  /** The preview this result belongs to (its nonce), so a new file starts clean. */
  forPreview?: string
}

export const initialPreview: PreviewState = { message: '' }
export const initialApply: ApplyState = { message: '' }

/** The screen calls file lines "rows"; the service's messages say "line". */
export function rowWording(message: string): string {
  return message.replace(/\b(on )?[Ll]ine (\d+)/g, (_m, on: string | undefined, n: string) =>
    on ? `on row ${n}` : `Row ${n}`,
  )
}
