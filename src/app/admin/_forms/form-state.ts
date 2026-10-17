import { DomainError } from '@/server/errors'

/** What every catalog form action returns. `errors` is keyed by field name. */
export interface FormState {
  message: string
  ok?: boolean
  errors?: Record<string, string>
  /** The submitted fields, echoed on a rejected save so the form keeps what was typed. */
  values?: Record<string, string>
  /** Changes with every result; the form is keyed on it to re-apply its defaults. */
  nonce?: string
}

/** A good save. No values, so the form shows the saved data again. */
export function done(message: string): FormState {
  return { message, ok: true, nonce: crypto.randomUUID() }
}

/** The text fields of a submission. `omit` leaves out anything that must not be sent back (PINs, passwords). */
export function submitted(formData: FormData, omit: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string' && !name.startsWith('$') && !omit.includes(name)) out[name] = value
  }
  return out
}

/** A typed value that could not be parsed; shown under its field. */
export class FieldError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message)
    this.name = 'FieldError'
  }
}

/** Domain errors become a form message; anything unexpected is rethrown. */
export function failure(
  e: unknown,
  notFound: string,
  formData: FormData,
  omit: readonly string[] = [],
): FormState {
  const base = { values: submitted(formData, omit), nonce: crypto.randomUUID() }
  if (e instanceof FieldError) return { ...base, message: e.message, errors: { [e.field]: e.message } }
  if (e instanceof DomainError) {
    if (e.code === 'forbidden') return { ...base, message: "You don't have permission to do that." }
    if (e.code === 'not_found') return { ...base, message: notFound }
    return { ...base, message: e.message }
  }
  throw e
}
