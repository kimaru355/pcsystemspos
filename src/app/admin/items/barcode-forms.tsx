'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Item } from '@/server/services/items'
import { addBarcodeAction, removeBarcodeAction } from './actions'
import { Field, Message, useKeptForm } from './form-kit'

export function AddBarcodeForm({ item }: { item: Item }) {
  const f = useKeptForm(addBarcodeAction)
  const { state, pending } = f
  const packs = item.packs.filter((p) => p.active)
  return (
    <form key={f.nonce} action={f.action} className="flex flex-col gap-2 pt-3" noValidate>
      <input type="hidden" name="itemId" value={item.id} />
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
        <Field id="new-barcode" label="Barcode" hint="Scan it or type it. Letters, digits, dots and dashes.">
          {(p) => <input {...p} name="barcode" required maxLength={64} autoComplete="off" defaultValue={f.text('barcode')} className={`${p.className} font-mono`} />}
        </Field>
        <Field id="new-barcode-unit" label="Sells as">
          {(p) => (
            <select {...p} name="packId" defaultValue={f.text('packId')}>
              <option value="">Base unit ({item.baseUnit})</option>
              {packs.map((pk) => (
                <option key={pk.id} value={pk.id}>
                  {pk.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mb-[1.1rem]">
          {pending ? 'Adding…' : 'Add barcode'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

/** Remove needs a second press: a mapping is hard-deleted, not deactivated. */
export function RemoveBarcodeForm({ itemId, barcodeId, code }: { itemId: string; barcodeId: string; code: string }) {
  const f = useKeptForm(removeBarcodeAction)
  const { state, pending } = f
  const [confirming, setConfirming] = useState(false)
  return (
    <form key={f.nonce} action={f.action} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="barcodeId" value={barcodeId} />
      {!confirming ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)} aria-label={`Remove barcode ${code}`}>
          Remove
        </Button>
      ) : (
        <>
          <span className="text-sm">Remove this barcode?</span>
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            {pending ? 'Removing…' : 'Confirm remove'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      )}
      {state.message && !state.ok && <Message state={state} className="w-full text-right" />}
    </form>
  )
}
