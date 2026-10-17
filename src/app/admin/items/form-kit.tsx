'use client'

import { useActionState } from 'react'
import { cn } from 'cn'
import type { FormState } from './form-state'
import { inputClass, labelClass } from './styles'

export const initialState: FormState = { message: '' }

/**
 * State for a catalog form that is a real `<form action={action}>` (a POST to the server action,
 * so it also works before hydration and never falls back to GET).
 *
 * React clears uncontrolled inputs when an action returns. To keep what was typed after a
 * rejected save, the server action echoes the submitted values in `state.values`; fields render
 * `text()` / `checked()` as their defaults, and the form is keyed on `nonce` so React applies those
 * defaults again after its reset. A good save returns no values, so the form shows the saved data
 * (or goes blank, for the add-a-row forms).
 *
 *   <form key={f.nonce} action={f.action}> ... defaultValue={f.text('name', saved)} ...
 */
export function useKeptForm(
  action: (prev: FormState, formData: FormData) => Promise<FormState>,
) {
  const [state, dispatch, pending] = useActionState(action, initialState)
  const values = state.values
  return {
    state,
    pending,
    action: dispatch,
    nonce: state.nonce,
    /** The submitted value after a rejected save, otherwise `saved`. */
    text: (name: string, saved = '') => values?.[name] ?? saved,
    /** A checkbox: absent from the submitted values means unchecked. */
    checked: (name: string, saved: boolean) => (values ? values[name] === 'on' : saved),
  }
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
