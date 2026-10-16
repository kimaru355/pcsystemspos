import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db/client'
import { SESSION_COOKIE, invalidateSession } from '@/server/auth/session'

/**
 * Landing point for signed-in users who have no usable tenant (see requireTenant).
 * Ends the session, clears the cookie and sends them to the login page, so `/` and
 * `/login` can never bounce them back and forth.
 */
export async function GET(request: NextRequest) {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) await invalidateSession(db, token)
  jar.delete(SESSION_COOKIE)
  return NextResponse.redirect(new URL('/login?error=no-access', request.url))
}
