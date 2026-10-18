import Dexie, { type EntityTable } from 'dexie'
import type { LineState } from '@/domain/order-state'
import type { Role } from '@/domain/permissions'
import type { Op, Section } from '@/domain/sync-ops'
import type { SectionData, TillSettings } from '@/domain/till-data'
import type { ClockState } from '@/domain/trusted-clock'

/*
 * The till's local database (IndexedDB via Dexie). Everything the till needs to run offline:
 * the device credential, the last pulled sections, the outbox of operations not yet
 * acknowledged by the server, and the people who signed in on this device.
 * Nothing here is deleted except outbox rows the server has answered.
 */

export type DeviceRecord = { token: string; deviceId: string; code: string }

/** Pending operation. `meta` lets the till show it before the server has it, without the catalog. */
export type OutboxRecord = {
  seq?: number
  op: Op
  meta: { actorName: string; lines?: LineState[] }
  createdAt: number
}

export type RejectedRecord = {
  id: string
  op: Op
  code: string
  message: string
  at: number
}

export type SectionRecord<S extends Section = Section> = { name: S; hash: string; data: SectionData[S] }

/** A person who signed in on this device; they unlock it offline with their PIN. */
export type EnrolledRecord = {
  membershipId: string
  name: string
  role: Role
  enrolledAt: number
  failures: number
  lockedUntil: number
}

export type SyncStatus = {
  /** Trusted time of the last successful sync. */
  lastSyncAt: number | null
  lastError: string | null
  /** The server refused this device (revoked, business suspended, unknown). */
  refused: 'revoked' | 'suspended' | 'unregistered' | null
}

export type KvMap = {
  device: DeviceRecord
  settings: TillSettings
  clock: ClockState
  /** Last order sequence used on this device. */
  orderSeq: number
  sync: SyncStatus
}

export type KvRecord = { key: keyof KvMap; value: unknown }

export class TillDb extends Dexie {
  kv!: EntityTable<KvRecord, 'key'>
  sections!: EntityTable<SectionRecord, 'name'>
  outbox!: EntityTable<OutboxRecord, 'seq'>
  rejected!: EntityTable<RejectedRecord, 'id'>
  enrolled!: EntityTable<EnrolledRecord, 'membershipId'>

  constructor(name = 'pos-till') {
    super(name)
    this.version(1).stores({
      kv: 'key',
      sections: 'name',
      outbox: '++seq',
      rejected: 'id, at',
      enrolled: 'membershipId',
    })
  }

  async getKv<K extends keyof KvMap>(key: K): Promise<KvMap[K] | undefined> {
    return (await this.kv.get(key))?.value as KvMap[K] | undefined
  }

  async setKv<K extends keyof KvMap>(key: K, value: KvMap[K]): Promise<void> {
    await this.kv.put({ key, value })
  }

  async section<S extends Section>(name: S): Promise<SectionRecord<S> | undefined> {
    return (await this.sections.get(name)) as SectionRecord<S> | undefined
  }
}

let instance: TillDb | undefined

/** The browser's till database (one per origin). */
export function tillDb(): TillDb {
  instance ??= new TillDb()
  return instance
}
