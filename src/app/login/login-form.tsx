'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { loginAction, type LoginState } from './actions'

const initialState: LoginState = { message: '' }
const inputClass =
  'h-11 w-full rounded-md border border-input bg-surface px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 md:h-10 md:text-sm'

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState)
  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="identifier" className="text-sm font-medium">
          Phone or email
        </label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          defaultValue={state.identifier ?? ''}
          required
          className={inputClass}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      <p aria-live="polite" className="min-h-5 text-sm text-destructive">
        {state.message}
      </p>
      <Button type="submit" size="lg" className="h-11 text-base md:h-10 md:text-sm" disabled={pending}>
        {pending ? 'Logging in…' : 'Log in'}
      </Button>
    </form>
  )
}
