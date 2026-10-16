import { describe, expect, it } from 'vitest'
import { assertTestDatabase } from '../helpers/test-db-guard'

describe('assertTestDatabase', () => {
  it('accepts a database whose name ends with _test', () => {
    expect(() => assertTestDatabase('postgres://pos:pos@localhost:5433/pos_test')).not.toThrow()
    expect(() => assertTestDatabase('postgres://pos:pos@localhost:5433/pos_test?sslmode=disable')).not.toThrow()
  })

  it.each([
    'postgres://pos:pos@localhost:5432/pos',
    'postgres://pos:pos@localhost:5432/pos_test_backup',
    'postgres://pos:pos@localhost:5432/',
    'not a url',
    '',
    undefined,
  ])('refuses %j', (url) => {
    expect(() => assertTestDatabase(url)).toThrow(/_test/)
  })
})
