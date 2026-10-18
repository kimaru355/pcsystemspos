'use client'

import { Button } from '@/components/ui/button'
import { Field, Message, useKeptForm } from '../_forms/form-kit'
import { cancelRemainderAction, refundAction } from './actions'

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
