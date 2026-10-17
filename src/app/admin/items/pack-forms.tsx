'use client'

import { Button } from '@/components/ui/button'
import { formatAmount, formatQty } from '@/domain/money'
import type { Item, Pack } from '@/server/services/items'
import { addPackAction, updatePackAction } from './actions'
import { Field, Message, useKeptForm } from './form-kit'

const GRID = 'grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_8rem]'

function PackRow({ item, pack }: { item: Item; pack: Pack }) {
  const { state, pending, formProps } = useKeptForm(updatePackAction)
  const err = state.errors ?? {}
  const id = `pack-${pack.id}`
  return (
    <form {...formProps} className="flex flex-col gap-2 border-b border-rule py-3" noValidate>
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="packId" value={pack.id} />
      <div className={GRID}>
        <Field id={`${id}-name`} label="Pack name">
          {(p) => <input {...p} name="name" required maxLength={40} defaultValue={pack.name} />}
        </Field>
        <Field id={`${id}-qty`} label={`Quantity (${item.baseUnit})`} error={err.qty}>
          {(p) => (
            <input {...p} name="qty" inputMode="decimal" required defaultValue={formatQty(pack.baseQtyMilli)} className={`${p.className} figures`} />
          )}
        </Field>
        <Field id={`${id}-price`} label="Price (KES)" error={err.price}>
          {(p) => (
            <input {...p} name="price" inputMode="decimal" required defaultValue={formatAmount(pack.priceCents)} className={`${p.className} figures`} />
          )}
        </Field>
        <Field id={`${id}-floor`} label="Lowest price" error={err.floor}>
          {(p) => (
            <input {...p} name="floor" inputMode="decimal" defaultValue={formatAmount(pack.floorCents)} className={`${p.className} figures`} />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={pack.active} />
          Active
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save pack'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}

export function AddPackForm({ item }: { item: Item }) {
  const { state, pending, formProps } = useKeptForm(addPackAction, { resetOnOk: true })
  const err = state.errors ?? {}
  return (
    <form {...formProps} className="flex flex-col gap-2 pt-3" noValidate>
      <input type="hidden" name="itemId" value={item.id} />
      <div className={GRID}>
        <Field id="new-pack-name" label="New pack name">
          {(p) => <input {...p} name="name" required maxLength={40} placeholder="Box of 12" />}
        </Field>
        <Field id="new-pack-qty" label={`Quantity (${item.baseUnit})`} error={err.qty}>
          {(p) => <input {...p} name="qty" inputMode="decimal" required placeholder="12" className={`${p.className} figures`} />}
        </Field>
        <Field id="new-pack-price" label="Price (KES)" error={err.price}>
          {(p) => <input {...p} name="price" inputMode="decimal" required className={`${p.className} figures`} />}
        </Field>
        <Field id="new-pack-floor" label="Lowest price" error={err.floor}>
          {(p) => <input {...p} name="floor" inputMode="decimal" placeholder="Same as price" className={`${p.className} figures`} />}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add pack'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}

/** Existing packs, editable. Owners only. */
export function PackList({ item }: { item: Item }) {
  return (
    <div className="flex flex-col">
      {item.packs.map((p) => (
        <PackRow key={p.id} item={item} pack={p} />
      ))}
    </div>
  )
}
