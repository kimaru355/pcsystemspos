import { describe, expect, it } from 'vitest'
import { isUuid } from '@/domain/ids'

describe('isUuid', () => {
  it.each([
    '123e4567-e89b-12d3-a456-426614174000',
    '123E4567-E89B-12D3-A456-426614174000',
    '00000000-0000-0000-0000-000000000000',
  ])('accepts %j', (s) => {
    expect(isUuid(s)).toBe(true)
  })

  it.each([
    '',
    'x',
    'not-a-uuid',
    '123e4567e89b12d3a456426614174000',
    '123e4567-e89b-12d3-a456-42661417400',
    '123e4567-e89b-12d3-a456-4266141740000',
    '123e4567-e89b-12d3-a456-42661417400g',
    ' 123e4567-e89b-12d3-a456-426614174000',
    "123e4567-e89b-12d3-a456-426614174000'; --",
  ])('rejects %j', (s) => {
    expect(isUuid(s)).toBe(false)
  })
})
