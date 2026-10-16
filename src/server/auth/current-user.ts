import { cache } from 'react'
import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { SESSION_COOKIE, validateSession } from './session'

export interface CurrentUser {
  id: string
  name: string
  isPlatformAdmin: boolean
  mustChangePassword: boolean
}

/**
 * Reads the session cookie and resolves the signed-in user (request-time: call it
 * inside a <Suspense> boundary). Deduplicated per request; never cached across requests.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await validateSession(db, token)
  if (!session) return null

  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      isPlatformAdmin: users.isPlatformAdmin,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .where(eq(users.id, session.userId))
  return user ?? null
})
