'use client'

import { useState } from 'react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ADJUST_REASONS, ADJUST_REASON_LABELS } from '@/domain/stock'
import { Field, Message, useKeptForm } from '../_forms/form-kit'
import { adjustStockAction, countStockAction, receiveStockAction } from './actions'

type Target = { outletId: string; itemId: string; baseUnit: string; fractional: boolean }

const FIELDS = 'grid gap-x-3 gap-y-2 sm:grid-cols-[8rem_8rem_minmax(0,1fr)_auto] sm:items-start'

function Hidden({ outletId, itemId }: Pick<Target, 'outletId' | 'itemId'>) {
  return (
    <>
      <input type="hidden" name="outletId" value={outletId} />
      <input type="hidden" name="itemId" value={itemId} />
    </>
  )
}

function qtyHint(t: Target) {
  return t.fractional ? undefined : 'Whole units only.'
}

function ReceiveForm(t: Target) {
  const f = useKeptForm(receiveStockAction)
  const { state, pending } = f
  const err = state.errors ?? {}
  const id = `receive-${t.itemId}`
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-2">
      <Hidden {...t} />
      <div className={FIELDS}>
        <Field id={`${id}-qty`} label={`Quantity (${t.baseUnit})`} hint={qtyHint(t)} error={err.qty}>
          {(p) => (
            <input {...p} name="qty" required inputMode={t.fractional ? 'decimal' : 'numeric'} defaultValue={f.text('qty')} className={`${p.className} figures`} />
          )}
        </Field>
        <Field id={`${id}-cost`} label="Unit cost (KES)" hint="Optional." error={err.unitCost}>
          {(p) => <input {...p} name="unitCost" inputMode="decimal" defaultValue={f.text('unitCost')} className={`${p.className} figures`} />}
        </Field>
        <Field id={`${id}-note`} label="Note" hint="Optional, like the supplier or delivery." error={err.note}>
          {(p) => <input {...p} name="note" maxLength={200} defaultValue={f.text('note')} />}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mt-[1.65rem]">
          {pending ? 'Receiving…' : 'Receive'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

function CountForm(t: Target) {
  const f = useKeptForm(countStockAction)
  const { state, pending } = f
  const err = state.errors ?? {}
  const id = `count-${t.itemId}`
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-2">
      <Hidden {...t} />
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-start">
        <Field id={`${id}-counted`} label={`Counted (${t.baseUnit})`} hint={qtyHint(t) ?? 'What is on the shelf now.'} error={err.counted}>
          {(p) => (
            <input {...p} name="counted" required inputMode={t.fractional ? 'decimal' : 'numeric'} defaultValue={f.text('counted')} className={`${p.className} figures`} />
          )}
        </Field>
        <Field id={`${id}-note`} label="Note" hint="Optional." error={err.note}>
          {(p) => <input {...p} name="note" maxLength={200} defaultValue={f.text('note')} />}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mt-[1.65rem]">
          {pending ? 'Saving…' : 'Record count'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

function ChangeForm(t: Target) {
  const f = useKeptForm(adjustStockAction)
  const { state, pending } = f
  const err = state.errors ?? {}
  const id = `change-${t.itemId}`
  return (
    <form key={f.nonce} action={f.action} noValidate className="flex flex-col gap-2">
      <Hidden {...t} />
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[8rem_11rem_minmax(0,1fr)_auto] sm:items-start">
        <Field id={`${id}-delta`} label={`Change (${t.baseUnit})`} hint={qtyHint(t) ?? 'Use - to take stock out, like -2.'} error={err.delta}>
          {(p) => <input {...p} name="delta" required inputMode="text" defaultValue={f.text('delta')} className={`${p.className} figures`} />}
        </Field>
        <Field id={`${id}-reason`} label="Reason" error={err.reason}>
          {(p) => (
            <select {...p} name="reason" defaultValue={f.text('reason', 'damaged')}>
              {ADJUST_REASONS.map((r) => (
                <option key={r} value={r}>
                  {ADJUST_REASON_LABELS[r]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${id}-note`} label="Note" hint="Required when the reason is Other." error={err.note}>
          {(p) => <input {...p} name="note" maxLength={200} defaultValue={f.text('note')} />}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mt-[1.65rem]">
          {pending ? 'Saving…' : 'Record change'}
        </Button>
      </div>
      <Message state={state} />
    </form>
  )
}

type Panel = 'receive' | 'adjust' | null

/**
 * The Receive and Adjust buttons of one stock row, and the form each opens beneath the row.
 * Renders into the row's grid: the buttons in a cell, the open form across the full width.
 */
export function StockRowActions({
  target,
  canReceive,
  canAdjust,
}: {
  target: Target
  canReceive: boolean
  canAdjust: boolean
}) {
  const [panel, setPanel] = useState<Panel>(null)
  const [mode, setMode] = useState<'count' | 'change'>('count')
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p))
  const panelId = `stock-panel-${target.itemId}`
  if (!canReceive && !canAdjust) return null

  return (
    <>
      <div className="flex gap-2 xl:justify-end">
        {canReceive && (
          <Button type="button" variant="outline" size="sm" aria-expanded={panel === 'receive'} aria-controls={panelId} onClick={() => toggle('receive')}>
            Receive
          </Button>
        )}
        {canAdjust && (
          <Button type="button" variant="outline" size="sm" aria-expanded={panel === 'adjust'} aria-controls={panelId} onClick={() => toggle('adjust')}>
            Adjust
          </Button>
        )}
      </div>
      {panel && (
        <div id={panelId} className="col-span-full mt-1 flex flex-col gap-3 border-l-2 border-foreground/80 bg-muted/50 px-3 py-3">
          {panel === 'receive' ? (
            <ReceiveForm {...target} />
          ) : (
            <>
              <div role="group" aria-label="Kind of adjustment" className="flex gap-4 text-sm">
                {(['count', 'change'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'rounded-sm py-0.5 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      mode === m ? 'font-semibold underline' : 'text-primary hover:underline',
                    )}
                  >
                    {m === 'count' ? 'Count (set what is on hand)' : 'Change (add or remove)'}
                  </button>
                ))}
              </div>
              {mode === 'count' ? <CountForm {...target} /> : <ChangeForm {...target} />}
            </>
          )}
        </div>
      )}
    </>
  )
}
