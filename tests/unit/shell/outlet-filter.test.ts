import { describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({ cookies: vi.fn() }))
const { resolveOutletFilter } = await import('@/server/outlet-filter')

describe('resolveOutletFilter', () => {
  it('keeps a stored outlet the user can still see', () => {
    expect(resolveOutletFilter('a', ['a', 'b'])).toBe('a')
  })
  it('falls back to all when nothing is stored', () => {
    expect(resolveOutletFilter(undefined, ['a'])).toBe('all')
  })
  it('falls back to all for an outlet outside the user scope', () => {
    expect(resolveOutletFilter('c', ['a', 'b'])).toBe('all')
  })
})
