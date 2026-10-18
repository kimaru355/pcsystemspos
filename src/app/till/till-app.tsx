'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { connectionLevel } from '@/domain/connection-modes'
import type { SectionData, TillStaff } from '@/domain/till-data'
import { msSinceSync } from '@/domain/trusted-clock'
import { tillEngine } from '@/client/till/engine'
import { buildView } from '@/client/till/view'
import { SetupScreen, UnlockScreen } from './till-access'
import { TillWorkspace } from './till-workspace'
import { TillCard } from './till-ui'

/** Registers the service worker in production builds so the till opens offline. */
function useServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {})
  }, [])
}

/**
 * The till: client-rendered from the local database, so it runs without the network once this
 * device is registered. Setup → unlock → workspace. The unlocked person lives in memory only:
 * a reload locks the till.
 */
export function TillApp() {
  const engine = useMemo(() => tillEngine(), [])
  const db = engine.db
  const [person, setPerson] = useState<TillStaff | null>(null)
  useServiceWorker()

  useEffect(() => {
    void engine.start()
    return () => engine.stop()
  }, [engine])

  // Re-render on clock ticks and sync rounds (time-based reminders).
  const clockMs = useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.clockState()?.trustedMs ?? 0,
    () => 0,
  )

  const data = useLiveQuery(async () => {
    const [device, settings, sync, sections, outbox, enrolled, rejected] = await Promise.all([
      db.getKv('device'),
      db.getKv('settings'),
      db.getKv('sync'),
      db.sections.toArray(),
      db.outbox.orderBy('seq').toArray(),
      db.enrolled.orderBy('membershipId').toArray(),
      db.rejected.orderBy('at').reverse().toArray(),
    ])
    return { device, settings, sync, sections, outbox, enrolled, rejected }
  }, [db])

  const view = useMemo(() => {
    if (!data) return null
    const sections = Object.fromEntries(data.sections.map((s) => [s.name, s.data])) as Partial<SectionData>
    return buildView(sections, data.settings ?? null, data.outbox)
  }, [data])

  if (!data || !view) {
    return (
      <div className="flex min-h-dvh flex-1 flex-col">
        <div className="h-12 bg-rail" />
        <p className="p-6 text-sm text-muted-foreground">Opening the till…</p>
      </div>
    )
  }

  const refused = data.sync?.refused ?? null
  if (!data.device || refused) return <SetupScreen engine={engine} refused={refused} />
  if (!data.settings) {
    return (
      <TillCard title="Getting this till ready">
        <p className="text-sm text-muted-foreground">
          Downloading the items, stock and staff for this outlet. This needs a connection the first time.
        </p>
        {data.sync?.lastError && <p className="text-sm text-credit">{data.sync.lastError}</p>}
      </TillCard>
    )
  }

  // Someone removed since unlocking is locked out at the next sync.
  const current = person ? (view.staff.find((s) => s.membershipId === person.membershipId) ?? null) : null
  if (!current) {
    return (
      <UnlockScreen
        engine={engine}
        enrolled={data.enrolled}
        staff={view.staff}
        outletLabel={`${data.settings.outlet.code} · ${data.settings.outlet.name}`}
        onUnlock={setPerson}
      />
    )
  }

  const clock = engine.clockState()
  const level = connectionLevel(data.settings.mode, clock && clockMs > 0 ? msSinceSync(clock) : Infinity)
  return (
    <TillWorkspace
      engine={engine}
      view={view}
      person={current}
      level={level}
      sync={data.sync ?? null}
      rejected={data.rejected}
      onLock={() => setPerson(null)}
    />
  )
}
