'use client'

import { Button } from '@/components/ui/button'
import { Field, Message, useKeptForm } from '../_forms/form-kit'
import { cancelRemainderAction, refundAction, resendReceiptAction } from './actions'

export function CancelRemainderForm({ orderId }: { orderId: string }) {
  const f = useKeptForm(cancelRemainderAction)
  const err = f.state.errors ?? {}
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field id="cancel-reason" label="Reason" hint="Required. Shown in the order's history and the audit log." error={err.reason}>
          {(p) => <input {...p} name="reason" maxLength={200} required defaultValue={f.text('reason')} />}
        </Field>
        <Button type="submit" variant="destructive" disabled={f.pending} className="sm:mb-5">
          {f.pending ? 'Cancelling…' : 'Cancel what is left'}
        </Button>
      </div>
      <Message state={f.state} />
    </form>
  )
}

export function RefundForm({ orderId, max }: { orderId: string; max: string }) {
  const f = useKeptForm(refundAction)
  const err = f.state.errors ?? {}
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <div className="grid gap-3 sm:grid-cols-[9rem_9rem_minmax(0,1fr)_auto] sm:items-start">
        <Field id="refund-amount" label="Amount (KES)" hint={`Up to ${max}.`} error={err.amount}>
          {(p) => <input {...p} name="amount" inputMode="decimal" required defaultValue={f.text('amount')} className={`${p.className} figures`} />}
        </Field>
        <Field id="refund-method" label="Given back by" error={err.method}>
          {(p) => (
            <select {...p} name="method" defaultValue={f.text('method', 'cash')}>
              <option value="cash">Cash</option>
              <option value="mpesa">M-Pesa</option>
              <option value="other">Other</option>
            </select>
          )}
        </Field>
        <Field id="refund-reason" label="Reason" error={err.reason}>
          {(p) => <input {...p} name="reason" maxLength={200} required defaultValue={f.text('reason')} />}
        </Field>
        <Button type="submit" disabled={f.pending} className="sm:mt-[1.65rem]">
          {f.pending ? 'Saving…' : 'Record refund'}
        </Button>
      </div>
      <Message state={f.state} />
    </form>
  )
}

export function ResendReceiptForm({
  orderId,
  receipts,
  phone,
}: {
  orderId: string
  receipts: { sourceId: string; label: string }[]
  phone: string
}) {
  const f = useKeptForm(resendReceiptAction)
  const err = f.state.errors ?? {}
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <Field id="resend-source" label="Receipt" error={err.sourceId}>
        {(p) => (
          <select {...p} name="sourceId" defaultValue={f.text('sourceId', receipts[0]?.sourceId ?? '')}>
            {receipts.map((r) => (
              <option key={r.sourceId} value={r.sourceId}>
                {r.label}
              </option>
            ))}
            <option value="">The order as it stands</option>
          </select>
        )}
      </Field>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
        <Field id="resend-channel" label="By" error={err.channel}>
          {(p) => (
            <select {...p} name="channel" defaultValue={f.text('channel', 'sms')}>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
            </select>
          )}
        </Field>
        <Field id="resend-to" label="To" error={err.to}>
          {(p) => <input {...p} name="to" defaultValue={f.text('to', phone)} placeholder="Phone or email" />}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={f.pending}>
          {f.pending ? 'Queuing…' : 'Send receipt'}
        </Button>
        <Message state={f.state} />
      </div>
    </form>
  )
}
