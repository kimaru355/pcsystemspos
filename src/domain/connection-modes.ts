export const CONNECTION_MODES = ['full_offline', 'default', 'always_online'] as const
export type ConnectionMode = (typeof CONNECTION_MODES)[number]

export const MODE_LABELS: Record<ConnectionMode, string> = {
  full_offline: 'Full offline',
  default: 'Default',
  always_online: 'Always online',
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/**
 * How long a till may go without a successful sync. Staff never see these numbers: the till
 * only reminds them to connect, more insistently as the block approaches.
 */
export const MODE_POLICIES: Record<ConnectionMode, { remindAfterMs: number | null; blockAfterMs: number | null }> = {
  full_offline: { remindAfterMs: null, blockAfterMs: null },
  default: { remindAfterMs: DAY, blockAfterMs: 7 * DAY },
  always_online: { remindAfterMs: HOUR, blockAfterMs: DAY },
}

/**
 * ok → remind (quiet line) → urge (banner, from halfway to the block) → insist (banner that stays,
 * from 85%) → blocked (no new sales).
 */
export type ConnectionLevel = 'ok' | 'remind' | 'urge' | 'insist' | 'blocked'

export function connectionLevel(mode: ConnectionMode, msSinceSync: number): ConnectionLevel {
  const { remindAfterMs, blockAfterMs } = MODE_POLICIES[mode]
  if (remindAfterMs === null || blockAfterMs === null) return 'ok'
  if (msSinceSync >= blockAfterMs) return 'blocked'
  if (msSinceSync < remindAfterMs) return 'ok'
  const share = (msSinceSync - remindAfterMs) / (blockAfterMs - remindAfterMs)
  if (share >= 0.85) return 'insist'
  if (share >= 0.5) return 'urge'
  return 'remind'
}

/** True when a device that last synced `msSinceSync` ago is past the point where staff are reminded. */
export function isPastReminder(mode: ConnectionMode, msSinceSync: number): boolean {
  return connectionLevel(mode, msSinceSync) !== 'ok'
}
