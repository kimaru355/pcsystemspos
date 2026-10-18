/*
 * The till's trusted clock (pure; the till persists the state and feeds it readings).
 *
 * Connection limits are measured from the last successful sync, so the till must not trust a
 * wall clock someone can turn back. It anchors on the server time at each sync, advances by the
 * monotonic clock while running, and never goes backwards (a high-water mark survives reloads).
 * A disagreement between the wall clock and the monotonic clock is a clock jump, reported to
 * the admin at the next sync.
 */

/** Wall-clock and monotonic-clock disagreement treated as someone changing the clock. */
export const CLOCK_JUMP_TOLERANCE_MS = 2 * 60 * 1000

export type ClockState = {
  /** Server time at the last successful sync (ms since epoch); null before the first sync. */
  serverSyncMs: number | null
  /** Trusted time of the last reading. Never decreases. */
  trustedMs: number
  /** Wall-clock time of the last reading. */
  lastWallMs: number
  /** Jumps seen since they were last reported. */
  pendingJumps: number
  lastJumpAtMs: number | null
}

export function initialClock(wallMs: number): ClockState {
  return { serverSyncMs: null, trustedMs: wallMs, lastWallMs: wallMs, pendingJumps: 0, lastJumpAtMs: null }
}

/**
 * Advance the clock. `monoElapsedMs` is the monotonic time since the last reading in this
 * page session, or null for the first reading after a (re)load, when only the wall clock is
 * available: then the clock moves forward by the wall clock but never back.
 */
export function tick(state: ClockState, wallMs: number, monoElapsedMs: number | null): ClockState {
  const wallElapsed = wallMs - state.lastWallMs
  let advance: number
  let jumped = false
  if (monoElapsedMs === null) {
    advance = Math.max(0, wallElapsed)
    jumped = wallElapsed < -CLOCK_JUMP_TOLERANCE_MS
  } else {
    advance = Math.max(0, monoElapsedMs)
    jumped = Math.abs(wallElapsed - monoElapsedMs) > CLOCK_JUMP_TOLERANCE_MS
  }
  const trustedMs = state.trustedMs + advance
  return {
    ...state,
    trustedMs,
    lastWallMs: wallMs,
    pendingJumps: state.pendingJumps + (jumped ? 1 : 0),
    lastJumpAtMs: jumped ? trustedMs : state.lastJumpAtMs,
  }
}

/** Re-anchor on the server's time after a successful sync; reported jumps are cleared. */
export function anchor(state: ClockState, serverMs: number, wallMs: number, reportedJumps: number): ClockState {
  return {
    serverSyncMs: serverMs,
    trustedMs: serverMs,
    lastWallMs: wallMs,
    pendingJumps: Math.max(0, state.pendingJumps - reportedJumps),
    lastJumpAtMs: state.lastJumpAtMs,
  }
}

/** Time since the last successful sync by the trusted clock; Infinity before the first. */
export function msSinceSync(state: ClockState): number {
  return state.serverSyncMs === null ? Infinity : Math.max(0, state.trustedMs - state.serverSyncMs)
}
