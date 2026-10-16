'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '@/db/client'
import { SESSION_COOKIE, invalidateSession } from '@/server/auth/session'

export async function logout(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) await invalidateSession(db, token)
  jar.delete(SESSION_COOKIE)
  redirect('/login')
}
