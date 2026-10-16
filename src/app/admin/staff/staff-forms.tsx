'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ROLE_LABELS, ROLES } from '@/domain/permissions'
import type { StaffMember } from '@/server/services/staff'
import {
  createStaffAction,
  deactivateStaffAction,
  setPinAction,
  updateStaffAction,
  type StaffFormState,
} from './actions'

type OutletOption = { id: string; label: string }

const initialState: StaffFormState = { message: '' }
const inputClass =
  'h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function Message({ state }: { state: StaffFormState }) {
  return (
    <p
      aria-live="polite"
      className={`min-h-5 text-sm ${state.ok ? 'text-muted-foreground' : 'text-destructive'}`}
    >
      {state.message}
    </p>
  )
}

function OutletChecks({
  options,
  selected,
  legend,
}: {
  options: OutletOption[]
  selected: string[]
  legend: string
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="outletIds" value={o.id} defaultChecked={selected.includes(o.id)} />
            {o.label}
          </label>
        ))}
        {options.length === 0 && <span className="text-sm text-muted-foreground">No active outlets.</span>}
      </div>
    </fieldset>
  )
}

export function CreateStaffForm({ outletOptions }: { outletOptions: OutletOption[] }) {
  const [state, action, pending] = useActionState(createStaffAction, initialState)
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-staff-name" className="text-sm font-medium">
          Name
        </label>
        <input id="new-staff-name" name="name" required className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-role" className="text-sm font-medium">
          Role
        </label>
        <select id="new-role" name="role" defaultValue="cashier" className={inputClass}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-phone" className="text-sm font-medium">
          Phone (or email)
        </label>
        <input id="new-phone" name="phone" type="tel" autoComplete="off" placeholder="0712 345 678" className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-email" className="text-sm font-medium">
          Email (optional if phone is given)
        </label>
        <input id="new-email" name="email" type="email" autoComplete="off" className={inputClass} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-password" className="text-sm font-medium">
          Temporary password (min 8 characters)
        </label>
        <input
          id="new-password"
          name="tempPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          className={inputClass}
        />
      </div>
      <div className="sm:col-span-2">
        <OutletChecks options={outletOptions} selected={[]} legend="Outlets (owners need none)" />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add staff member'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}

function EditForm({ member, outletOptions }: { member: StaffMember; outletOptions: OutletOption[] }) {
  const [state, action, pending] = useActionState(updateStaffAction, initialState)
  return (
    <form action={action} className="flex flex-col gap-3 border-t pt-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <div className="flex flex-col gap-1.5 sm:max-w-48">
        <label htmlFor={`role-${member.membershipId}`} className="text-sm font-medium">
          Role
        </label>
        <select
          id={`role-${member.membershipId}`}
          name="role"
          defaultValue={member.role}
          className={inputClass}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <OutletChecks options={outletOptions} selected={member.outletIds} legend="Outlets" />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        <Message state={state} />
      </div>
    </form>
  )
}

function PinForm({ member }: { member: StaffMember }) {
  const [state, action, pending] = useActionState(setPinAction, initialState)
  return (
    <form action={action} className="flex flex-wrap items-end gap-3 border-t pt-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`pin-${member.membershipId}`} className="text-sm font-medium">
          {member.hasPin ? 'New PIN (4 to 6 digits)' : 'Set PIN (4 to 6 digits)'}
        </label>
        <input
          id={`pin-${member.membershipId}`}
          name="pin"
          type="password"
          inputMode="numeric"
          pattern="\d{4,6}"
          minLength={4}
          maxLength={6}
          autoComplete="off"
          required
          className={`${inputClass} w-36`}
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? 'Saving…' : 'Set PIN'}
      </Button>
      <Message state={state} />
    </form>
  )
}

function DeactivateForm({ member }: { member: StaffMember }) {
  const [state, action, pending] = useActionState(deactivateStaffAction, initialState)
  const [confirming, setConfirming] = useState(false)
  return (
    <form action={action} className="flex flex-wrap items-center gap-3 border-t pt-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      {!confirming ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Deactivate
        </Button>
      ) : (
        <>
          <span className="text-sm">Deactivate {member.name}? They will be signed out immediately.</span>
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>
            {pending ? 'Deactivating…' : 'Confirm deactivate'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      )}
      <Message state={state} />
    </form>
  )
}

export function StaffRow({
  member,
  outletOptions,
  outletCodes,
  isSelf,
  canManage,
}: {
  member: StaffMember
  outletOptions: OutletOption[]
  outletCodes: Record<string, string>
  isSelf: boolean
  canManage: boolean
}) {
  const codes = member.outletIds.map((id) => outletCodes[id]).filter(Boolean)
  const contact = [member.phone, member.email].filter(Boolean).join(' · ')
  // Managers may only reset PINs of the active cashiers the list already limits them to.
  const canSetPin = member.active && (canManage || member.role === 'cashier')
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">
          {member.name}
          {isSelf && <span className="font-normal text-muted-foreground"> (you)</span>}
        </p>
        <p className="text-sm text-muted-foreground">{contact}</p>
        <p className="text-sm">
          {ROLE_LABELS[member.role]} · Outlets: {codes.length > 0 ? codes.join(', ') : 'none'} · PIN:{' '}
          {member.hasPin ? 'set' : 'not set'} · {member.active ? 'Active' : 'Inactive'}
        </p>
      </div>
      {canManage && member.active && <EditForm member={member} outletOptions={outletOptions} />}
      {canSetPin && <PinForm member={member} />}
      {canManage && member.active && !isSelf && <DeactivateForm member={member} />}
    </div>
  )
}
