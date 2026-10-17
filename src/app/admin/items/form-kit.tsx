'use client'

import { useActionState, useEffect, useRef, useTransition } from 'react'
import { cn } from 'cn'
import type { FormState } from './form-state'
import { inputClass, labelClass } from './styles'

export const initialState: FormState = { message: '' }

/**
 * Like `<form action>`, but React does not wipe the typed values when the action returns, so a
 * rejected save keeps what the person typed. `resetOnOk` clears the form after a good save
 * (the add-a-row forms).
 */
export function useKeptForm(
  action: (prev: FormState, formData: FormData) => Promise<FormState>,
  { resetOnOk = false }: { resetOnOk?: boolean } = {},
) {
  const [state, dispatch, pending] = useActionState(action, initialState)
  const [, startTransition] = useTransition()
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (resetOnOk && state.ok) ref.current?.reset()
  }, [resetOnOk, state])
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    startTransition(() => dispatch(data))
  }
  return { state, pending, formProps: { ref, onSubmit } }
}

export function Message({ state, className }: { state: FormState; className?: string }) {
  // A message that belongs to one field is shown under that field instead.
  if (state.errors && Object.keys(state.errors).length > 0) {
    return <p aria-live="polite" className={cn('min-h-5 text-sm', className)} />
  }
  return (
    <p
      aria-live="polite"
      className={cn('min-h-5 text-sm', state.ok ? 'text-muted-foreground' : 'text-destructive', className)}
    >
      {state.message}
    </p>
  )
}

/** A label, its control and the field's own error. `children` receives props to spread on the control. */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  className?: string
  children: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string; className: string }) => React.ReactNode
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ')
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy || undefined,
        className: inputClass,
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
