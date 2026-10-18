import { describe, expect, it } from 'vitest'
import { connectionLevel, isPastReminder } from '@/domain/connection-modes'
import { checkPin, createPinVerifier, pinLockoutMs } from '@/domain/pin'
import { opSchema, syncRequestSchema } from '@/domain/sync-ops'
import { anchor, initialClock, msSinceSync, tick } from '@/domain/trusted-clock'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const ID = '11111111-1111-4111-8111-111111111111'

describe('connection levels', () => {
  it('full offline never reminds or blocks', () => {
    expect(connectionLevel('full_offline', 365 * DAY)).toBe('ok')
  })

  it('default mode: remind after a day, urge from halfway, insist from 85%, block at 7 days', () => {
    expect(connectionLevel('default', DAY - 1)).toBe('ok')
    expect(connectionLevel('default', DAY)).toBe('remind')
    expect(connectionLevel('default', 4 * DAY)).toBe('urge')
    expect(connectionLevel('default', 6.2 * DAY)).toBe('insist')
    expect(connectionLevel('default', 7 * DAY)).toBe('blocked')
  })

  it('always online: remind after an hour, block after a day', () => {
    expect(connectionLevel('always_online', 59 * 60_000)).toBe('ok')
    expect(connectionLevel('always_online', HOUR)).toBe('remind')
    expect(connectionLevel('always_online', DAY)).toBe('blocked')
    expect(isPastReminder('always_online', 2 * HOUR)).toBe(true)
  })

  it('a till that never synced is blocked', () => {
    expect(connectionLevel('default', Infinity)).toBe('blocked')
  })
})

describe('trusted clock', () => {
  const t0 = Date.UTC(2026, 9, 18, 8)

  it('advances by the monotonic clock while running', () => {
    let c = anchor(initialClock(t0), t0, t0, 0)
    c = tick(c, t0 + 60_000, 60_000)
    expect(msSinceSync(c)).toBe(60_000)
    expect(c.pendingJumps).toBe(0)
  })

  it('ignores a wall clock turned back while running, and counts the jump', () => {
    let c = anchor(initialClock(t0), t0, t0, 0)
    c = tick(c, t0 - DAY, 30_000)
    expect(msSinceSync(c)).toBe(30_000)
    expect(c.pendingJumps).toBe(1)
  })

  it('never goes backwards across a reload, and counts a clock set back while closed', () => {
    let c = anchor(initialClock(t0), t0, t0, 0)
    c = tick(c, t0 + HOUR, HOUR)
    c = tick(c, t0, null) // reloaded with the wall clock an hour behind
    expect(msSinceSync(c)).toBe(HOUR)
    expect(c.pendingJumps).toBe(1)
  })

  it('counts time the app was closed by the wall clock', () => {
    let c = anchor(initialClock(t0), t0, t0, 0)
    c = tick(c, t0 + 3 * DAY, null)
    expect(msSinceSync(c)).toBe(3 * DAY)
  })

  it('a sync re-anchors and clears reported jumps', () => {
    let c = anchor(initialClock(t0), t0, t0, 0)
    c = tick(c, t0 - DAY, 1000)
    c = anchor(c, t0 + 5000, t0 - DAY + 5000, 1)
    expect(c.pendingJumps).toBe(0)
    expect(msSinceSync(c)).toBe(0)
  })
})

describe('PIN verifier', () => {
  it('checks the PIN it was made from and nothing else', async () => {
    const v = await createPinVerifier('4821')
    expect(await checkPin('4821', v)).toBe(true)
    expect(await checkPin('4822', v)).toBe(false)
    expect(await checkPin('48', v)).toBe(false)
    expect(await checkPin('4821', { salt: '!!', verifier: v.verifier })).toBe(false)
  })

  it('uses a fresh salt each time', async () => {
    const [a, b] = await Promise.all([createPinVerifier('1234'), createPinVerifier('1234')])
    expect(a.salt).not.toBe(b.salt)
    expect(a.verifier).not.toBe(b.verifier)
  })

  it('locks out after five wrong PINs, doubling', () => {
    expect(pinLockoutMs(4)).toBe(0)
    expect(pinLockoutMs(5)).toBe(60_000)
    expect(pinLockoutMs(6)).toBe(120_000)
    expect(pinLockoutMs(50)).toBe(3_600_000)
  })
})

describe('sync op schemas', () => {
  const adjust = {
    id: ID,
    type: 'stock.adjust',
    actorId: ID,
    occurredAt: '2026-10-18T08:00:00.000Z',
    payload: { movementId: ID, itemId: ID, deltaMilli: -2000, reason: 'damaged', note: null },
  }

  it('parses a valid op', () => {
    expect(opSchema.safeParse(adjust).success).toBe(true)
  })

  it.each([
    ['a bad uuid', { ...adjust, id: 'x' }],
    ['an unknown type', { ...adjust, type: 'order.delete' }],
    ['a zero change', { ...adjust, payload: { ...adjust.payload, deltaMilli: 0 } }],
    ['a fractional milli', { ...adjust, payload: { ...adjust.payload, deltaMilli: 1.5 } }],
    ['an unknown reason', { ...adjust, payload: { ...adjust.payload, reason: 'gift' } }],
    ['a bad time', { ...adjust, occurredAt: 'yesterday' }],
  ])('refuses %s', (_n, op) => {
    expect(opSchema.safeParse(op).success).toBe(false)
  })

  it('caps a sync at 100 ops', () => {
    const body = { ops: Array(101).fill(adjust), hashes: {}, clock: { jumps: 0, lastJumpAt: null } }
    expect(syncRequestSchema.safeParse(body).success).toBe(false)
  })
})
