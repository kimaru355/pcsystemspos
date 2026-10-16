'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { login } from '@/server/auth/login'
import { SESSION_COOKIE } from '@/server/auth/session'

export interface LoginState {
  message: string
  /** Echoed back because React resets the form after an action. */
  identifier?: string
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get('identifier') ?? '')
  const password = String(formData.get('password') ?? '')
  if (!identifier.trim() || !password) {
    return { message: 'Wrong phone/email or password.', identifier }
  }

  const result = await login(db, { identifier, password })
  if (!result.ok) {
    return {
      message:
        result.reason === 'locked'
          ? 'Too many attempts. Try again in 15 minutes.'
          : 'Wrong phone/email or password.',
      identifier,
    }
  }

  ;(await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: result.expiresAt,
  })
  redirect(result.mustChangePassword ? '/change-password' : '/')
}
