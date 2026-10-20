'use client'

import { Button } from '@/components/ui/button'
import { inputClass } from '../_forms/styles'
import { Message, useKeptForm } from '../_forms/form-kit'
import { attachPaymentAction } from './actions'

export function AttachForm({ transactionId, guess }: { transactionId: string; guess: string }) {
  const f = useKeptForm(attachPaymentAction)
  if (f.state.ok) return <Message state={f.state} />
  return (
    <form key={f.nonce} action={f.action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="transactionId" value={transactionId} />
      <label className="sr-only" htmlFor={`attach-${transactionId}`}>
        Order number
      </label>
      <input
        id={`attach-${transactionId}`}
        name="orderNumber"
        defaultValue={f.text('orderNumber', guess)}
        placeholder="Order number"
        className={`${inputClass} w-44 font-mono`}
      />
      <Button type="submit" size="lg" disabled={f.pending}>
        {f.pending ? 'Attaching…' : 'Attach'}
      </Button>
      <Message state={f.state} className="w-full" />
    </form>
  )
}
