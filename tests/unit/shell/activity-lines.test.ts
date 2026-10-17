import { describe, expect, it } from 'vitest'
import { toConfirmation, type Names } from '@/app/admin/activity-lines'
import type { ActivityEntry } from '@/server/services/activity'

const names: Names = {
  outlets: new Map([['o1', { code: 'KTL', name: 'Kitale' }]]),
  staff: new Map([['m1', 'Jane Wanjiru']]),
}

function entry(partial: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: 'e',
    action: 'x',
    entityType: 'outlet',
    entityId: 'o1',
    data: null,
    reason: null,
    actorName: 'Olivia Owner',
    at: new Date('2026-10-17T07:00:00Z'),
    ...partial,
  }
}

describe('toConfirmation', () => {
  it('leads an outlet event with the outlet code', () => {
    const c = toConfirmation(entry({ action: 'outlet.create', data: { name: 'Kitale', code: 'KTL', connectionMode: null } }), names)
    expect(c).toMatchObject({ code: 'KTL', status: 'Outlet opened', by: 'Olivia Owner' })
    expect(c.detail).toBe('Kitale, business default mode.')
  })

  it('describes what changed on an outlet update', () => {
    const c = toConfirmation(
      entry({
        action: 'outlet.update',
        data: { before: { name: 'Kitale', connectionMode: null, active: true }, after: { name: 'Kitale', connectionMode: 'always_online', active: false } },
      }),
      names,
    )
    expect(c.detail).toBe('Kitale: connection mode set to Always online, closed.')
    expect(c.tone).toBeUndefined()
  })

  it('uses initials for staff and never mentions the PIN itself', () => {
    const c = toConfirmation(entry({ action: 'staff.set_pin', entityType: 'membership', entityId: 'm1' }), names)
    expect(c).toMatchObject({ code: 'JW', status: 'Till PIN set', detail: 'for Jane Wanjiru.' })
  })

  it('reads a business default mode change', () => {
    const c = toConfirmation(
      entry({ action: 'business.default_mode', entityType: 'business', entityId: 'b', data: { before: 'default', after: 'full_offline' } }),
      names,
    )
    expect(c).toMatchObject({ code: 'ALL', status: 'Default mode changed' })
    expect(c.detail).toContain('Default to Full offline')
  })
})
