export type DomainErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'duplicate_code'
  | 'invalid_input'
  | 'conflict'

export class DomainError extends Error {
  constructor(
    public code: DomainErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'DomainError'
  }
}
