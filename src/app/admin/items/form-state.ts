import { DomainError } from '@/server/errors'

/** What every catalog form action returns. `errors` is keyed by field name. */
export interface FormState {
  message: string
  ok?: boolean
  errors?: Record<string, string>
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
export function failure(e: unknown, notFound: string): FormState {
  if (e instanceof FieldError) return { message: e.message, errors: { [e.field]: e.message } }
  if (e instanceof DomainError) {
    if (e.code === 'forbidden') return { message: "You don't have permission to do that." }
    if (e.code === 'not_found') return { message: notFound }
    return { message: e.message }
  }
  throw e
}
