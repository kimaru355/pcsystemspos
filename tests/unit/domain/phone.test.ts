import { describe, expect, it } from 'vitest'
import { normalizeKePhone } from '@/domain/phone'

describe('normalizeKePhone', () => {
  it.each(['0712345678', '712345678', '254712345678', '+254 712 345 678'])(
    'normalizes %j to E.164',
    (input) => {
      expect(normalizeKePhone(input)).toBe('+254712345678')
    },
  )

  it('accepts the 01 range', () => {
    expect(normalizeKePhone('0110123456')).toBe('+254110123456')
  })

  it.each(['0812345678', '12345', ''])('rejects %j', (input) => {
    expect(normalizeKePhone(input)).toBeNull()
  })
})
