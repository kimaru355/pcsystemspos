'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, Delete, ShieldCheck } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { ConnectionStatus } from '@/components/shell/connection-status'
import { checkPin, pinLockoutMs } from '@/domain/pin'
import { ROLE_LABELS } from '@/domain/permissions'
import type { TillStaff } from '@/domain/till-data'
import type { EnrolledRecord } from '@/client/till/db'
import { TillApiFailure, type TillEngine } from '@/client/till/engine'
import { ErrorText, fieldClass, labelClass, Modal, TillCard } from './till-ui'

type OutletOption = { id: string; code: string; name: string }

/** Register this browser as a till. Needs an owner or manager signed in on the web. */
export function SetupScreen({ engine, refused }: { engine: TillEngine; refused: string | null }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'signed_out'; message: string }
    | { kind: 'ready'; userName: string; outlets: OutletOption[] }
  >({ kind: 'loading' })
  const [outletId, setOutletId] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/till/register', { cache: 'no-store' })
      .then(async (res) => {
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (res.ok && data) {
          setState({ kind: 'ready', userName: data.userName, outlets: data.outlets })
          setOutletId(data.outlets[0]?.id ?? '')
        } else {
          setState({ kind: 'signed_out', message: data?.message ?? 'Sign in first.' })
        }
      })
      .catch(() => !cancelled && setState({ kind: 'signed_out', message: 'Setting up a till needs a connection.' }))
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await engine.register(outletId, name)
    } catch (err) {
      setError(err instanceof TillApiFailure ? err.message : 'The till could not be set up. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <TillCard
      title={
        refused === 'revoked'
          ? 'This till was revoked'
          : refused === 'suspended'
            ? 'This business is suspended'
            : 'Set up this device as a till'
      }
      footer={<ConnectionStatus />}
    >
      {refused === 'suspended' && (
        <p className="text-sm text-muted-foreground">
          The platform suspended this business. Sales on this device are kept and sent once it is active again.
        </p>
      )}
      {refused === 'revoked' && (
        <p className="text-sm text-muted-foreground">
          An owner or manager revoked this till. Its unsynced sales are still on this device and are sent as soon as
          it is set up again.
        </p>
      )}
      {state.kind === 'loading' && <p className="text-sm text-muted-foreground">Checking who is signed in…</p>}
      {state.kind === 'signed_out' && (
        <>
          <p className="text-sm text-muted-foreground">
            An owner or manager sets up each till once, online. {state.message}
          </p>
          <a href="/login" className="text-sm font-medium text-primary hover:underline">
            Sign in as an owner or manager
          </a>
          <p className="text-xs text-muted-foreground">After signing in, come back to this page.</p>
        </>
      )}
      {state.kind === 'ready' &&
        (state.outlets.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no active outlet to set a till up for.</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">Signed in as {state.userName}.</p>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="till-outlet" className={labelClass}>
                Outlet
              </label>
              <select id="till-outlet" value={outletId} onChange={(e) => setOutletId(e.target.value)} className={fieldClass}>
                {state.outlets.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.code} · {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="till-name" className={labelClass}>
                Name of this till
              </label>
              <input
                id="till-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Front counter"
                required
                className={fieldClass}
              />
            </div>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" size="lg" className="h-11 text-base" disabled={busy}>
              {busy ? 'Setting up…' : 'Set up till'}
            </Button>
          </form>
        ))}
    </TillCard>
  )
}

/** Four to six dots and a keypad: works with touch, a keyboard or a number row. */
function PinPad({ onSubmit, disabled, error }: { onSubmit: (pin: string) => void; disabled?: boolean; error?: string | null }) {
  const [pin, setPin] = useState('')
  const press = (d: string) => !disabled && setPin((p) => (p.length < 6 ? p + d : p))
  const submit = () => {
    if (pin.length >= 4 && !disabled) {
      onSubmit(pin)
      setPin('')
    }
  }
  return (
    <div className="flex flex-col items-center gap-4">
      <input
        aria-label="PIN"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        value={pin}
        disabled={disabled}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        className={cn(fieldClass, 'figures w-40 text-center text-2xl tracking-[0.5em]')}
      />
      <ErrorText>{error}</ErrorText>
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            className="figures size-16 rounded-lg border border-rule bg-surface text-xl font-semibold hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          aria-label="Delete last digit"
          onClick={() => setPin((p) => p.slice(0, -1))}
          className="flex size-16 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
        >
          <Delete aria-hidden className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          className="figures size-16 rounded-lg border border-rule bg-surface text-xl font-semibold hover:bg-muted"
        >
          0
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pin.length < 4 || disabled}
          className="size-16 rounded-lg bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          OK
        </button>
      </div>
    </div>
  )
}

/** Wall-clock time, read outside render. */
function wallNow(): number {
  return Date.now()
}

/** The current time, refreshed every few seconds (for lockout countdowns). */
function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const update = () => setNow(wallNow())
    update()
    const t = setInterval(update, everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

function lockoutText(ms: number): string {
  const min = Math.ceil(ms / 60_000)
  return `Too many wrong PINs. Try again in ${min} minute${min === 1 ? '' : 's'}.`
}

/** Pick your name and enter your PIN (offline), or sign in for the first time on this device. */
export function UnlockScreen({
  engine,
  enrolled,
  staff,
  outletLabel,
  onUnlock,
}: {
  engine: TillEngine
  enrolled: EnrolledRecord[]
  staff: TillStaff[]
  outletLabel: string
  onUnlock: (s: TillStaff) => void
}) {
  const byId = new Map(staff.map((s) => [s.membershipId, s]))
  const people = enrolled.filter((e) => byId.get(e.membershipId)?.pin)
  const [chosen, setChosen] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(people.length === 0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ identifier: '', password: '', pin: '' })

  const now = useNow()
  const person = chosen ? enrolled.find((e) => e.membershipId === chosen) : null
  const lockedMs = person && now > 0 ? Math.max(0, person.lockedUntil - now) : 0

  async function tryPin(pin: string) {
    if (!person) return
    const s = byId.get(person.membershipId)
    if (!s?.pin) return
    if (await checkPin(pin, s.pin)) {
      await engine.db.enrolled.update(person.membershipId, { failures: 0, lockedUntil: 0 })
      onUnlock(s)
      return
    }
    const failures = person.failures + 1
    const wait = pinLockoutMs(failures)
    await engine.db.enrolled.update(person.membershipId, { failures, lockedUntil: wait ? wallNow() + wait : 0 })
    setError(wait ? lockoutText(wait) : 'Wrong PIN.')
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const s = await engine.signIn(form.identifier, form.password, form.pin)
      onUnlock(s)
    } catch (err) {
      setError(
        err instanceof TillApiFailure
          ? err.status === 0
            ? 'Signing in for the first time on a till needs a connection.'
            : err.message
          : 'Could not sign in. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  if (signingIn) {
    return (
      <TillCard title="Sign in to this till" footer={<><span>{outletLabel}</span> · <ConnectionStatus className="inline-flex" /></>}>
        <p className="text-sm text-muted-foreground">
          The first time on this device, sign in online. After that your PIN opens the till, even without internet.
        </p>
        <form onSubmit={signIn} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="si-id" className={labelClass}>
              Phone or email
            </label>
            <input
              id="si-id"
              autoComplete="username"
              value={form.identifier}
              onChange={(e) => setForm({ ...form, identifier: e.target.value })}
              required
              className={fieldClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="si-pw" className={labelClass}>
              Password
            </label>
            <input
              id="si-pw"
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              className={fieldClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="si-pin" className={labelClass}>
              PIN
            </label>
            <input
              id="si-pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              required
              minLength={4}
              className={cn(fieldClass, 'figures')}
            />
            <p className="text-xs text-muted-foreground">4 to 6 digits. If you have no PIN yet, this sets it.</p>
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" className="h-11 text-base" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          {people.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSigningIn(false)
                setError(null)
              }}
              className="text-sm font-medium text-primary hover:underline"
            >
              Back to the people on this till
            </button>
          )}
        </form>
      </TillCard>
    )
  }

  if (person) {
    return (
      <TillCard title={person.name}>
        <button
          type="button"
          onClick={() => {
            setChosen(null)
            setError(null)
          }}
          className="-mt-2 inline-flex items-center gap-1 self-start text-sm font-medium text-primary hover:underline"
        >
          <ChevronLeft aria-hidden className="size-4" /> Someone else
        </button>
        <p className="text-sm text-muted-foreground">Enter your PIN.</p>
        <PinPad onSubmit={tryPin} disabled={lockedMs > 0} error={lockedMs > 0 ? lockoutText(lockedMs) : error} />
      </TillCard>
    )
  }

  return (
    <TillCard title="Who is selling?" footer={<><span>{outletLabel}</span> · <ConnectionStatus className="inline-flex" /></>}>
      <ul className="flex flex-col gap-2">
        {people.map((p) => (
          <li key={p.membershipId}>
            <button
              type="button"
              onClick={() => setChosen(p.membershipId)}
              className="flex h-14 w-full items-center justify-between rounded-lg border border-rule bg-surface px-4 text-left hover:border-foreground/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted-foreground">{ROLE_LABELS[p.role]}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setSigningIn(true)} className="text-sm font-medium text-primary hover:underline">
        Sign in someone new
      </button>
    </TillCard>
  )
}

/** An owner or manager approves with their PIN, on this till, offline. */
export function ApproverDialog({
  open,
  onOpenChange,
  title,
  reason,
  approvers,
  onApproved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** What is being approved, in one sentence. */
  reason: string
  approvers: TillStaff[]
  onApproved: (membershipId: string) => void
}) {
  const [chosen, setChosen] = useState<string | null>(approvers.length === 1 ? approvers[0].membershipId : null)
  const [error, setError] = useState<string | null>(null)
  const [failures, setFailures] = useState<Record<string, number>>({})
  const approver = approvers.find((a) => a.membershipId === chosen) ?? null
  const blocked = approver ? pinLockoutMs(failures[approver.membershipId] ?? 0) > 0 : false

  async function tryPin(pin: string) {
    if (!approver?.pin) return
    if (await checkPin(pin, approver.pin)) {
      setError(null)
      onApproved(approver.membershipId)
      onOpenChange(false)
      return
    }
    setFailures((f) => ({ ...f, [approver.membershipId]: (f[approver.membershipId] ?? 0) + 1 }))
    setError('Wrong PIN.')
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <div className="flex flex-col gap-4">
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          {reason}
        </p>
        {approvers.length === 0 ? (
          <p className="text-sm">
            No owner or manager has a PIN on this till yet. They need to sign in on it once, online.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Approver">
              {approvers.map((a) => (
                <button
                  key={a.membershipId}
                  type="button"
                  role="radio"
                  aria-checked={a.membershipId === chosen}
                  onClick={() => {
                    setChosen(a.membershipId)
                    setError(null)
                  }}
                  className={cn(
                    'h-10 rounded-md border px-3 text-sm font-medium',
                    a.membershipId === chosen ? 'border-primary bg-primary/10 text-primary' : 'border-rule hover:bg-muted',
                  )}
                >
                  {a.name} <span className="font-normal text-muted-foreground">· {ROLE_LABELS[a.role]}</span>
                </button>
              ))}
            </div>
            {approver && (
              <PinPad
                key={approver.membershipId}
                onSubmit={tryPin}
                disabled={blocked}
                error={blocked ? 'Too many wrong PINs on this till.' : error}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
