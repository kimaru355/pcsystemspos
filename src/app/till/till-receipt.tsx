'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Bluetooth, Mail, MessageSquare, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatKes } from '@/domain/money'
import type { OrderEvent, OrderState } from '@/domain/order-state'
import { buildReceipt, escposBytes, receiptText, receiptTime } from '@/domain/receipt'
import type { Actor } from '@/client/till/actions'
import { canPrintBluetooth, printBluetooth } from '@/client/till/bluetooth'
import type { TillEngine } from '@/client/till/engine'
import type { TillView } from '@/client/till/view'
import { ErrorText, fieldClass } from './till-ui'

/* Print (browser at 80mm, or Bluetooth ESC/POS) and send (SMS, email) a receipt from the till. */

function eventLabel(e: OrderEvent | null): string {
  if (!e) return 'The order as it stands'
  const time = receiptTime(e.at)
  if (e.kind === 'collection') return `Collection note · ${time}`
  return `Payment ${formatKes(e.amountCents ?? 0)} · ${time}`
}

export function ReceiptPanel({
  engine,
  view,
  actor,
  order,
  onDone,
}: {
  engine: TillEngine
  view: TillView
  actor: Actor
  order: OrderState
  onDone: () => void
}) {
  const events = order.events.filter((e) => (e.kind === 'payment' || e.kind === 'collection') && e.sourceId)
  const [chosen, setChosen] = useState<string>(events[0]?.sourceId ?? '')
  const event = events.find((e) => e.sourceId === chosen) ?? null
  const [to, setTo] = useState(order.customer?.phone ?? '')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const place = { business: view.settings?.businessName ?? '', outlet: { code: view.settings?.outlet.code ?? '', name: view.settings?.outlet.name ?? '' } }
  const text = receiptText(buildReceipt(order, place, event))

  async function send(channel: 'sms' | 'email', address: string) {
    setError(null)
    if (!address.trim()) return setError(channel === 'sms' ? 'Enter a phone number.' : 'Enter an email address.')
    await engine.enqueue(
      {
        id: crypto.randomUUID(),
        type: 'receipt.send',
        actorId: actor.membershipId,
        occurredAt: new Date(engine.trustedNow()).toISOString(),
        payload: { orderId: order.id, sourceId: event?.sourceId ?? null, channel, to: address.trim() },
      },
      { actorName: actor.name },
    )
    setStatus(navigator.onLine ? `${channel === 'sms' ? 'SMS' : 'Email'} on its way.` : `${channel === 'sms' ? 'SMS' : 'Email'} will be sent once the till is online.`)
  }

  async function bluetooth() {
    setError(null)
    try {
      const name = await printBluetooth(escposBytes(text))
      setStatus(`Printed on ${name}.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Printing failed.')
    }
  }

  function print() {
    // Only the print-only copy below shows on paper (see globals.css).
    window.print()
  }

  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-3">
      {events.length > 0 && (
        <select aria-label="Receipt for" value={chosen} onChange={(e) => setChosen(e.target.value)} className={fieldClass}>
          {events.map((e) => (
            <option key={e.sourceId} value={e.sourceId}>
              {eventLabel(e)}
            </option>
          ))}
          <option value="">{eventLabel(null)}</option>
        </select>
      )}
      <pre aria-label="Receipt preview" className="max-h-56 overflow-auto rounded-md border border-rule bg-background p-3 font-mono text-[0.7rem] leading-snug">
        {text}
      </pre>
      <div className="grid grid-cols-2 gap-2">
        <Button size="lg" variant="outline" className="h-11" onClick={print}>
          <Printer aria-hidden /> Print
        </Button>
        {canPrintBluetooth() && (
          <Button size="lg" variant="outline" className="h-11" onClick={() => void bluetooth()}>
            <Bluetooth aria-hidden /> Bluetooth printer
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <input aria-label="Phone for SMS" inputMode="tel" placeholder="Phone for SMS" value={to} onChange={(e) => setTo(e.target.value)} className={fieldClass} />
        <Button size="lg" variant="outline" className="h-11" onClick={() => void send('sms', to)}>
          <MessageSquare aria-hidden /> SMS
        </Button>
      </div>
      <div className="flex gap-2">
        <input aria-label="Email address" inputMode="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} className={fieldClass} />
        <Button size="lg" variant="outline" className="h-11" onClick={() => void send('email', email)}>
          <Mail aria-hidden /> Email
        </Button>
      </div>
      {status && <p role="status" className="text-sm font-medium text-paid">{status}</p>}
      <ErrorText>{error}</ErrorText>
      <Button size="lg" variant="ghost" className="h-11" onClick={onDone}>
        Done
      </Button>
      {createPortal(<pre className="print-receipt">{text}</pre>, document.body)}
    </div>
  )
}
