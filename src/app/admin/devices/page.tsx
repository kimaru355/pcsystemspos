import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { MODE_LABELS } from '@/domain/connection-modes'
import { listDevices, type DeviceRow } from '@/server/services/devices'
import { requireTenant } from '@/server/tenant'
import { RevokeDevice } from './device-forms'

const when = new Intl.DateTimeFormat('en-KE', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Nairobi',
})

export default function DevicesPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Tills" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <DevicesContent />
    </Suspense>
  )
}

const COLUMNS = 'lg:grid-cols-[6rem_minmax(0,1fr)_10rem_minmax(0,14rem)_auto]'

function Flags({ d }: { d: DeviceRow }) {
  const flags: string[] = []
  if (d.pastReminder) flags.push('Not synced for a while')
  if (d.clockJumps > 0) flags.push(`Clock changed ${d.clockJumps} ${d.clockJumps === 1 ? 'time' : 'times'}`)
  if (flags.length === 0) return null
  return <span className="font-medium text-owed-ink">{flags.join(' · ')}</span>
}

async function DevicesContent() {
  const ctx = await requireTenant()
  const devices = await listDevices(db, ctx)
  const active = devices.filter((d) => !d.revokedAt)
  const revoked = devices.filter((d) => d.revokedAt)
  return (
    <>
      <PageHeader
        title="Tills"
        description="Every device set up as a till, when it last synced, and anything to look at. To add a till, open the till page on the new device while signed in."
      />
      <Region
        id="tills-heading"
        title="Active tills"
        aside={<span className="text-xs text-muted-foreground">{active.length}</span>}
      >
        {active.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            No tills yet. On the phone or PC that will sell, sign in as an owner or manager and open /till.
          </p>
        ) : (
          <ul>
            {active.map((d) => (
              <li
                key={d.id}
                className={`grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-b border-rule py-2.5 text-sm ${COLUMNS}`}
              >
                <span className="font-mono text-[0.8rem] font-medium">
                  {d.outletCode}-{d.code}
                </span>
                <span className="min-w-0">
                  <span className="font-medium">{d.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {d.outletName} · {MODE_LABELS[d.mode]} · set up by {d.registeredByName}
                  </span>
                </span>
                <span className="col-span-2 text-xs text-muted-foreground lg:col-span-1 lg:text-sm">
                  {d.lastSyncAt ? `Synced ${when.format(d.lastSyncAt)}` : 'Never synced'}
                </span>
                <span className="col-span-2 text-xs lg:col-span-1">
                  <Flags d={d} />
                </span>
                <span className="col-span-2 lg:col-span-1 lg:justify-self-end">
                  <RevokeDevice deviceId={d.id} label={`${d.outletCode}-${d.code}`} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Region>
      {revoked.length > 0 && (
        <div className="pt-8">
          <Region id="revoked-heading" title="Revoked" size="sm">
            <ul>
              {revoked.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-rule py-2 text-sm text-muted-foreground">
                  <span className="font-mono text-[0.8rem]">
                    {d.outletCode}-{d.code}
                  </span>
                  <span>{d.name}</span>
                  <span className="text-xs">Revoked {when.format(d.revokedAt!)}</span>
                </li>
              ))}
            </ul>
          </Region>
        </div>
      )}
    </>
  )
}
