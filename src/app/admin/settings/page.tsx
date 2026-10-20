import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/page-header'
import { Region } from '@/components/shell/region'
import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { getMpesaSettings, type MpesaConfigView } from '@/server/services/mpesa'
import { listOutlets } from '@/server/services/outlets'
import { messagingConfigured, smsUsage } from '@/server/services/receipts'
import { requireTenant } from '@/server/tenant'
import { MpesaConfigForm, RegisterC2BForm } from './mpesa-forms'

const when = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' })

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <>
          <PageHeader title="Settings" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </>
      }
    >
      <SettingsContent />
    </Suspense>
  )
}

function C2BStatus({ c }: { c: MpesaConfigView }) {
  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-3 text-sm">
      <p className="text-muted-foreground">
        {c.c2bRegisteredAt
          ? `Paybill and till payments registered on ${when.format(c.c2bRegisteredAt)}.`
          : 'Paybill and till payments made by customers reach the system once this number is registered with Safaricom.'}
      </p>
      {c.confirmationUrl && <p className="font-mono text-xs break-all text-muted-foreground">{c.confirmationUrl}</p>}
      <RegisterC2BForm configId={c.id} />
    </div>
  )
}

async function SettingsContent() {
  const ctx = await requireTenant()
  if (!can(ctx.role, 'business.settings')) {
    return (
      <>
        <PageHeader title="Settings" />
        <p className="text-sm text-muted-foreground">Only the owner manages the business settings.</p>
      </>
    )
  }
  const monthStart = startOfNairobiMonth(new Date())
  const [{ configs, appUrlSet, secretsKeySet }, outlets, usage] = await Promise.all([
    getMpesaSettings(db, ctx),
    listOutlets(db, ctx),
    smsUsage(db, ctx, monthStart),
  ])
  const messaging = messagingConfigured()
  const business = configs.find((c) => c.outletId === null) ?? null
  const active = outlets.filter((o) => o.active)

  return (
    <>
      <PageHeader title="Settings" description="Payments and messages for the whole business." />
      <div className="flex max-w-3xl flex-col gap-10">
        <Region id="mpesa-heading" title="M-Pesa">
          <p className="pb-4 text-sm text-muted-foreground">
            Money goes straight to your own paybill or till. The details come from the Safaricom Daraja portal. An outlet
            with its own till number can override the business settings.
          </p>
          {(!appUrlSet || !secretsKeySet) && (
            <p role="alert" className="mb-4 rounded-md border border-credit/30 bg-credit/5 p-3 text-sm text-credit">
              The server is missing {[!appUrlSet && 'APP_URL', !secretsKeySet && 'SECRETS_KEY'].filter(Boolean).join(' and ')}. Ask
              whoever runs the server to set it before M-Pesa can work.
            </p>
          )}
          <h3 className="pb-2 text-sm font-semibold">Business default</h3>
          <MpesaConfigForm id="mpesa-business" outletId={null} saved={business} />
          {business && <div className="pt-3"><C2BStatus c={business} /></div>}

          {active.map((o) => {
            const c = configs.find((x) => x.outletId === o.id) ?? null
            return (
              <details key={o.id} className="mt-6 border-t border-rule pt-3" open={c !== null}>
                <summary className="cursor-pointer text-sm font-semibold">
                  <span className="font-mono">{o.code}</span> · {o.name} {c ? '· own M-Pesa' : '· uses the business default'}
                </summary>
                <div className="pt-3">
                  <MpesaConfigForm id={`mpesa-${o.code}`} outletId={o.id} saved={c} />
                  {c && <div className="pt-3"><C2BStatus c={c} /></div>}
                </div>
              </details>
            )
          })}
        </Region>

        <Region id="messages-heading" title="SMS and email receipts">
          <p className="pb-3 text-sm text-muted-foreground">
            Tills send receipts by SMS from the platform&apos;s sender name and by email from the platform&apos;s mail server.
          </p>
          <dl className="grid grid-cols-[10rem_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-muted-foreground">SMS</dt>
            <dd>{messaging.sms ? 'Ready' : 'Not set up on the server yet: SMS wait in the queue.'}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd>{messaging.email ? 'Ready' : 'Not set up on the server yet: emails wait in the queue.'}</dd>
            <dt className="text-muted-foreground">SMS this month</dt>
            <dd className="figures">
              {usage.messages} {usage.messages === 1 ? 'message' : 'messages'}, {usage.segments} billed {usage.segments === 1 ? 'part' : 'parts'}
            </dd>
          </dl>
        </Region>
      </div>
    </>
  )
}

const monthKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit' })

/** The first moment of this month in Nairobi (UTC+3 all year). */
function startOfNairobiMonth(now: Date): Date {
  const [y, m] = monthKey.format(now).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1) - 3 * 60 * 60 * 1000)
}
