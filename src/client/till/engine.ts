import { anchor, initialClock, tick, type ClockState } from '@/domain/trusted-clock'
import { SECTIONS, type Op, type OpResult, type Section } from '@/domain/sync-ops'
import type { SyncResponse, TillApiError, TillStaff } from '@/domain/till-data'
import type { LineState } from '@/domain/order-state'
import { tillDb, type DeviceRecord, type SyncStatus, type TillDb } from './db'

/*
 * The till engine: trusted clock, outbox and sync loop. One instance per page.
 *
 * Sync: every 30 s while the page is open, right after a new operation, and when the browser
 * comes online. A failure backs off 5 s, 10 s, 20 s … up to 5 minutes. Acknowledged ops leave
 * the outbox in the same IndexedDB transaction that stores the pulled sections, so the view
 * never shows an op twice or loses one.
 */

const SYNC_EVERY_MS = 30_000
const TICK_EVERY_MS = 15_000
const BACKOFF_MIN_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000
const BATCH = 100

export class TillApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    throw new TillApiFailure(0, 'offline', 'No connection to the server.')
  }
  const data = (await res.json().catch(() => null)) as (T & Partial<TillApiError>) | null
  if (!res.ok || data === null) {
    throw new TillApiFailure(res.status, data?.error ?? 'server_error', data?.message ?? 'The server could not be reached.')
  }
  return data
}

export class TillEngine {
  private clock: ClockState | null = null
  private lastMono = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private syncing: Promise<void> | null = null
  private again = false
  private backoffMs = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<() => void>()

  constructor(
    readonly db: TillDb = tillDb(),
    private readonly now: () => number = () => Date.now(),
    private readonly mono: () => number = () => performance.now(),
  ) {}

  /** Load the clock and start the timers. */
  async start(): Promise<void> {
    const saved = await this.db.getKv('clock')
    this.clock = tick(saved ?? initialClock(this.now()), this.now(), null)
    this.lastMono = this.mono()
    await this.db.setKv('clock', this.clock)
    if (typeof window !== 'undefined') {
      this.timers.push(setInterval(() => void this.tickClock(), TICK_EVERY_MS))
      this.timers.push(setInterval(() => void this.syncNow(), SYNC_EVERY_MS))
      window.addEventListener('online', this.onOnline)
    }
    void this.syncNow()
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
  }

  private onOnline = () => {
    this.backoffMs = 0
    void this.syncNow()
  }

  /** Called whenever the clock or sync status changes (for re-rendering time-based UI). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  async tickClock(): Promise<ClockState> {
    const mono = this.mono()
    this.clock = tick(this.clock ?? initialClock(this.now()), this.now(), mono - this.lastMono)
    this.lastMono = mono
    await this.db.setKv('clock', this.clock)
    this.emit()
    return this.clock
  }

  /** The trusted time now (ms since epoch). */
  trustedNow(): number {
    if (!this.clock) return this.now()
    return this.clock.trustedMs + Math.max(0, this.mono() - this.lastMono)
  }

  clockState(): ClockState | null {
    return this.clock
  }

  // ------------------------------------------------------------------ outbox

  /** Queue an operation and try to send it straight away. */
  async enqueue(op: Op, meta: { actorName: string; lines?: LineState[] }): Promise<void> {
    await this.db.outbox.add({ op, meta, createdAt: this.now() })
    void this.syncNow()
  }

  /** The next order sequence for this device (never reused, even across reloads). */
  async nextOrderSeq(): Promise<number> {
    return this.db.transaction('rw', this.db.kv, async () => {
      const settings = await this.db.getKv('settings')
      const current = Math.max((await this.db.getKv('orderSeq')) ?? 0, settings?.lastOrderSeq ?? 0)
      await this.db.setKv('orderSeq', current + 1)
      return current + 1
    })
  }

  // -------------------------------------------------------------------- sync

  /** Run a sync now (coalesced with one already running). */
  syncNow(): Promise<void> {
    if (this.syncing) {
      this.again = true
      return this.syncing
    }
    this.syncing = (async () => {
      try {
        let answered = 0
        do {
          this.again = false
          answered = await this.syncRound()
          // Keep going while ops are queued and the server is answering them.
        } while (this.again || (answered > 0 && (await this.db.outbox.count()) > 0))
        this.backoffMs = 0
      } catch (e) {
        await this.recordFailure(e)
      } finally {
        this.syncing = null
        this.emit()
      }
    })()
    return this.syncing
  }

  private async recordFailure(e: unknown) {
    const f = e instanceof TillApiFailure ? e : new TillApiFailure(0, 'error', String(e))
    const status = (await this.db.getKv('sync')) ?? { lastSyncAt: null, lastError: null, refused: null }
    const refused =
      f.status === 401 && (f.code === 'revoked' || f.code === 'suspended' || f.code === 'unregistered')
        ? f.code
        : status.refused
    await this.db.setKv('sync', { ...status, lastError: f.message, refused })
    // A revoked or unknown till waits for someone to register it again; a suspended business may
    // be reactivated, so that one keeps retrying.
    if (refused === 'revoked' || refused === 'unregistered') return
    this.backoffMs = Math.min(Math.max(this.backoffMs * 2, BACKOFF_MIN_MS), BACKOFF_MAX_MS)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.syncNow(), this.backoffMs)
  }

  /** One push/pull; returns how many ops the server answered. */
  private async syncRound(): Promise<number> {
    const device = await this.db.getKv('device')
    if (!device) return 0
    const status = await this.db.getKv('sync')
    if (status?.refused === 'revoked' || status?.refused === 'unregistered') return 0
    const pending = await this.db.outbox.orderBy('seq').limit(BATCH).toArray()
    const sections = await this.db.sections.toArray()
    const hashes = Object.fromEntries(sections.map((s) => [s.name, s.hash]))
    const clock = await this.tickClock()
    const reportedJumps = clock.pendingJumps
    const res = await postJson<SyncResponse>(
      '/api/sync',
      {
        ops: pending.map((p) => p.op),
        hashes,
        clock: {
          jumps: reportedJumps,
          lastJumpAt: clock.lastJumpAtMs === null ? null : new Date(clock.lastJumpAtMs).toISOString(),
        },
      },
      device.token,
    )
    await this.applyResponse(device, pending.map((p) => p.seq!), res, reportedJumps)
    return res.results.length
  }

  private async applyResponse(device: DeviceRecord, seqs: number[], res: SyncResponse, reportedJumps: number) {
    const answered = new Map<string, OpResult>(res.results.map((r) => [r.id, r]))
    const db = this.db
    await db.transaction('rw', [db.outbox, db.rejected, db.sections, db.kv, db.enrolled], async () => {
      const sent = await db.outbox.bulkGet(seqs)
      for (const rec of sent) {
        if (!rec) continue
        const r = answered.get(rec.op.id)
        if (!r) continue
        if (r.status === 'rejected') {
          await db.rejected.put({
            id: rec.op.id,
            op: rec.op,
            code: r.code ?? 'rejected',
            message: r.message ?? 'The server refused this.',
            at: this.now(),
          })
        }
        await db.outbox.delete(rec.seq!)
      }
      for (const name of SECTIONS) {
        const s = res.sections[name as Section]
        if (s) await db.sections.put({ name, hash: s.hash, data: s.data } as never)
      }
      await db.setKv('settings', res.settings)
      if (res.settings.device.id !== device.deviceId) {
        await db.setKv('device', { ...device, deviceId: res.settings.device.id, code: res.settings.device.code })
      }
      const seq = (await db.getKv('orderSeq')) ?? 0
      if (res.settings.lastOrderSeq > seq) await db.setKv('orderSeq', res.settings.lastOrderSeq)
      const serverMs = Date.parse(res.serverTime)
      this.clock = anchor(this.clock ?? initialClock(this.now()), serverMs, this.now(), reportedJumps)
      this.lastMono = this.mono()
      await db.setKv('clock', this.clock)
      const sync: SyncStatus = { lastSyncAt: serverMs, lastError: null, refused: null }
      await db.setKv('sync', sync)
      // Forget people who are no longer allowed on this till.
      const staff = res.sections.staff?.data.staff
      if (staff) {
        const allowed = new Map(staff.map((p) => [p.membershipId, p]))
        for (const e of await db.enrolled.toArray()) {
          const p = allowed.get(e.membershipId)
          if (!p) await db.enrolled.delete(e.membershipId)
          else if (p.name !== e.name || p.role !== e.role) await db.enrolled.put({ ...e, name: p.name, role: p.role })
        }
      }
    })
  }

  // ---------------------------------------------------------- registration

  /** Register this browser as a till (an owner or manager is signed in on the web). */
  async register(outletId: string, name: string): Promise<void> {
    const r = await postJson<{ token: string; deviceId: string; code: string }>('/api/till/register', { outletId, name })
    // A browser registered again keeps its outbox; the old till's settings go, so no sale is
    // numbered with the old till's code until the new one's settings arrive.
    await this.db.transaction('rw', [this.db.kv, this.db.sections], async () => {
      await this.db.kv.delete('settings')
      await this.db.setKv('device', { token: r.token, deviceId: r.deviceId, code: r.code })
      await this.db.setKv('sync', { lastSyncAt: null, lastError: null, refused: null })
      await this.db.setKv('orderSeq', 0)
      await this.db.sections.clear()
    })
    this.backoffMs = 0
    await this.syncNow()
  }

  /** First sign-in of a person on this till (online). */
  async signIn(identifier: string, password: string, pin: string): Promise<TillStaff> {
    const device = await this.db.getKv('device')
    if (!device) throw new TillApiFailure(401, 'unregistered', 'This till is not registered.')
    const { staff } = await postJson<{ staff: TillStaff }>('/api/till/sign-in', { identifier, password, pin }, device.token)
    await this.db.enrolled.put({
      membershipId: staff.membershipId,
      name: staff.name,
      role: staff.role,
      enrolledAt: this.now(),
      failures: 0,
      lockedUntil: 0,
    })
    // Make sure the staff section (with this person's verifier) is current.
    await this.syncNow()
    return staff
  }
}

let engine: TillEngine | undefined

export function tillEngine(): TillEngine {
  engine ??= new TillEngine()
  return engine
}

export type { SyncStatus }
