'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { MODE_LABELS, type ConnectionMode } from '@/domain/connection-modes'
import type { Outlet } from '@/server/services/outlets'
import {
  createOutletAction,
  setDefaultModeAction,
  updateOutletAction,
  type OutletFormState,
} from './actions'

const initialState: OutletFormState = { message: '' }
const inputClass =
  'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function Message({ state }: { state: OutletFormState }) {
  return (
    <p
      aria-live="polite"
      className={`min-h-5 text-sm ${state.ok ? 'text-muted-foreground' : 'text-destructive'}`}
    >
      {state.message}
    </p>
  )
}

function ModeOptions({ withInherit }: { withInherit: boolean }) {
  return (
    <>
      {withInherit && <option value="">Use business default</option>}
      {(Object.keys(MODE_LABELS) as ConnectionMode[]).map((m) => (
        <option key={m} value={m}>
          {MODE_LABELS[m]}
        </option>
      ))}
    </>
  )
}

export function DefaultModeForm({ current }: { current: ConnectionMode }) {
  const [state, action, pending] = useActionState(setDefaultModeAction, initialState)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="default-mode" className="text-sm font-medium">
          Business default connection mode
        </label>
        <select id="default-mode" name="mode" defaultValue={current} className={inputClass}>
          <ModeOptions withInherit={false} />
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save default'}
      </Button>
      <Message state={state} />
    </form>
  )
}

export function CreateOutletForm() {
  const [state, action, pending] = useActionState(createOutletAction, initialState)
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-name" className="text-sm font-medium">
          Outlet name
        </label>
        <input id="new-name" name="name" required className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-code" className="text-sm font-medium">
          Code (2 to 5 letters or digits)
        </label>
        <input
          id="new-code"
          name="code"
          required
          minLength={2}
          maxLength={5}
          autoCapitalize="characters"
          className={`${inputClass} uppercase`}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-mode" className="text-sm font-medium">
          Connection mode
        </label>
        <select id="new-mode" name="connectionMode" defaultValue="" className={inputClass}>
          <ModeOptions withInherit />
        </select>
      </div>
      <div className="flex items-end gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create outlet'}
        </Button>
      </div>
      <div className="sm:col-span-2">
        <Message state={state} />
      </div>
    </form>
  )
}

export function OutletRow({ outlet }: { outlet: Outlet }) {
  const [state, action, pending] = useActionState(updateOutletAction, initialState)
  const id = `outlet-${outlet.id}`
  return (
    <form action={action} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[5rem_1fr_12rem_auto_auto] sm:items-end">
      <input type="hidden" name="outletId" value={outlet.id} />
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Code</span>
        <span className="flex h-9 items-center font-mono text-sm">{outlet.code}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="text-sm font-medium">
          Name
        </label>
        <input id={`${id}-name`} name="name" defaultValue={outlet.name} required className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-mode`} className="text-sm font-medium">
          Connection mode
        </label>
        <select
          id={`${id}-mode`}
          name="connectionMode"
          defaultValue={outlet.connectionMode ?? ''}
          className={inputClass}
        >
          <ModeOptions withInherit />
        </select>
      </div>
      <label className="flex h-9 items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={outlet.active} />
        Active
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <p className="text-sm text-muted-foreground sm:col-span-5">
        Effective mode: {MODE_LABELS[outlet.effectiveMode]}
        {outlet.connectionMode === null && ' (business default)'}
      </p>
      <div className="sm:col-span-5">
        <Message state={state} />
      </div>
    </form>
  )
}
