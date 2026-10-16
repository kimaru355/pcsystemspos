import { describe, expect, it } from 'vitest'
import { parseEnv } from '@/env'

describe('parseEnv', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/)
  })

  it('returns parsed values when valid', () => {
    const env = parseEnv({ DATABASE_URL: 'postgres://x', NODE_ENV: 'test' })
    expect(env.DATABASE_URL).toBe('postgres://x')
    expect(env.NODE_ENV).toBe('test')
  })
})
