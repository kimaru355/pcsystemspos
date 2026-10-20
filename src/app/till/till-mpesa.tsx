'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Smartphone, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatKes } from '@/domain/money'
import { orderFigures, type OrderState } from '@/domain/order-state'
import type { Actor } from '@/client/till/actions'
import { TillApiFailure, TillMpesa, type StkView, type TillEngine, type UnmatchedPayment } from '@/client/till/engine'
import type { TillView } from '@/client/till/view'
import { AmountField, ErrorText, fieldClass, labelClass, PanelEmpty } from './till-ui'

/* M-Pesa on the till: STK push for an order, and attaching unmatched payments. Online only. */

function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true)
}

export function MpesaUnavailable() {
  return (
    <p className="flex items-center gap-2 rounded-md border border-rule bg-muted px-3 py-2 text-sm text-muted-foreground">
      <WifiOff aria-hidden className="size-4" /> M-Pesa unavailable while offline. Cash still works.
    </p>
  )
}

const POLL_MS = 3000

/** Send an STK push for the order and follow it until the customer answers. */
export function MpesaPayForm({
  engine,
  actor,
  order,
  onDone,
}: {
  engine: TillEngine
  actor: Actor
  order: OrderState
  onDone: () => void
}) {
  const online = useOnline()
  const due = Math.max(0, orderFigures(order).balanceCents)
  const [phone, setPhone] = useState(order.customer?.phone ?? '')
  const [amount, setAmount] = useState<number | null>(Math.ceil(due / 100) * 100)
  const [push, setPush] = useState<StkView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mpesa = useRef(new TillMpesa(engine))

  useEffect(() => {
    if (!push || push.status !== 'pending') return
    const t = setTimeout(async () => {
      try {
        const next = await mpesa.current.status(push.id)
        setPush(next)
        if (next.status === 'success') void engine.syncNow()
      } catch {
        setPush({ ...push }) // retry on the next tick
      }
    }, POLL_MS)
    return () => clearTimeout(t)
  }, [push, engine])

  async function send() {
    setError(null)
    if (amount === null || amount <= 0 || amount % 100 !== 0) {
      setError('M-Pesa takes whole shillings.')
      return
    }
    setBusy(true)
    try {
      setPush(await mpesa.current.push(order.id, phone, amount, actor.membershipId))
    } catch (e) {
      setError(e instanceof TillApiFailure ? e.message : 'M-Pesa could not be reached. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (!online && !push) return <MpesaUnavailable />

  if (push) {
    const text: Record<StkView['status'], string> = {
      pending: `Waiting for the customer to enter their M-Pesa PIN on ${push.phone}…`,
      success: `Paid ${formatKes(push.amountCents)} by M-Pesa.${push.receipt ? ` Receipt ${push.receipt}.` : ''}`,
      failed: push.message ? `Not paid: ${push.message}` : 'Not paid.',
      timeout: 'No answer from the phone. If the customer paid, it will show on the order when M-Pesa confirms it.',
    }
    return (
      <div className="flex flex-col gap-3" role="status">
        <p className={push.status === 'success' ? 'text-sm font-medium text-paid' : 'text-sm'}>{text[push.status]}</p>
        <div className="grid grid-cols-2 gap-2">
          {push.status !== 'pending' && push.status !== 'success' && (
            <Button variant="outline" size="lg" className="h-11" onClick={() => setPush(null)}>
              Try again
            </Button>
          )}
          <Button size="lg" variant={push.status === 'success' ? 'default' : 'ghost'} className="h-11" onClick={onDone}>
            {push.status === 'success' ? 'Done' : 'Close'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="stk-phone" className={labelClass}>
          M-Pesa phone
        </label>
        <input id="stk-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0712 345 678" className={fieldClass} />
      </div>
      <AmountField
        id="stk-amount"
        label="Amount (whole shillings)"
        initial={String(Math.ceil(due / 100))}
        onValue={setAmount}
        hint={`Balance ${formatKes(due)}`}
      />
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button size="lg" className="h-11" disabled={busy || !amount} onClick={() => void send()}>
          <Smartphone aria-hidden /> {busy ? 'Sending…' : 'Send to phone'}
        </Button>
        <Button size="lg" variant="ghost" className="h-11" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

const when = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Nairobi' })

/** The Payments tab: M-Pesa payments that arrived without a matching order number. */
export function PaymentsPanel({ engine, view, actor }: { engine: TillEngine; view: TillView; actor: Actor }) {
  const online = useOnline()
  const mpesa = useRef(new TillMpesa(engine))
  const [list, setList] = useState<UnmatchedPayment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)
  const open = view.orders.filter((o) => o.status === 'open')

  async function load() {
    setError(null)
    try {
      setList(await mpesa.current.unmatched())
    } catch (e) {
      setError(e instanceof TillApiFailure ? e.message : 'Could not load payments.')
    }
  }

  const enabled = online && !!view.settings?.mpesa
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    mpesa.current
      .unmatched()
      .then((l) => !cancelled && setList(l))
      .catch((e) => !cancelled && setError(e instanceof TillApiFailure ? e.message : 'Could not load payments.'))
    return () => {
      cancelled = true
    }
  }, [enabled])

  async function attach(p: UnmatchedPayment) {
    const orderId = choice[p.id]
    if (!orderId) return
    try {
      const r = await mpesa.current.attach(p.id, orderId, actor.membershipId)
      setDone(`${p.transId} attached to ${r.orderNumber}.`)
      await load()
    } catch (e) {
      setError(e instanceof TillApiFailure ? e.message : 'Could not attach the payment.')
    }
  }

  if (!view.settings?.mpesa) {
    return <PanelEmpty title="M-Pesa is not set up" body="The owner sets up M-Pesa in Admin, under Settings. Cash and approved payments work as usual." />
  }
  if (!online) return <div className="p-4"><MpesaUnavailable /></div>

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-3 md:p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Payments to match</h2>
        <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        M-Pesa payments that arrived without a matching order number. Attach each one to the order it pays for.
      </p>
      {done && <p role="status" className="text-sm font-medium text-paid">{done}</p>}
      <ErrorText>{error}</ErrorText>
      {list === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing waiting.</p>
      ) : (
        <ul className="divide-y divide-rule rounded-md border border-rule bg-surface">
          {list.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 px-3 py-3">
              <p className="text-sm">
                <span className="font-mono text-[0.8rem] font-medium">{p.transId}</span>{' '}
                <span className="figures font-semibold">{formatKes(p.amountCents)}</span>
                <span className="block text-xs text-muted-foreground">
                  {when.format(new Date(p.transTime))} · {p.payerName ?? 'Unknown payer'} {p.msisdn ?? ''}
                  {p.billRef && <> · account “{p.billRef}”</>}
                </span>
              </p>
              <div className="flex gap-2">
                <select
                  aria-label={`Order for ${p.transId}`}
                  value={choice[p.id] ?? ''}
                  onChange={(e) => setChoice((c) => ({ ...c, [p.id]: e.target.value }))}
                  className={fieldClass}
                >
                  <option value="">Choose an open order</option>
                  {open.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.number} · {o.customer?.name ?? 'Walk-in'} · {formatKes(Math.max(0, orderFigures(o).balanceCents))} owed
                    </option>
                  ))}
                </select>
                <Button size="lg" className="h-11" disabled={!choice[p.id]} onClick={() => void attach(p)}>
                  Attach
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
