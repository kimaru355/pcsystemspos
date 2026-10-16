import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { db } from '@/db/client'
import { getCurrentUser } from '@/server/auth/current-user'
import { SESSION_COOKIE, invalidateSession } from '@/server/auth/session'
import { getTenantCtx } from '@/server/tenant'

/**
 * Landing point for signed-in users who have no usable tenant (see requireTenant).
 * Ends the session, clears the cookie and sends them to the login page, so `/` and
 * `/login` can never bounce them back and forth. It only acts when that really is the
 * caller's state: anyone else (signed out, platform admin, or a user with a working
 * tenant) is sent to `/` untouched, so a stray link cannot sign a user out.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.isPlatformAdmin || (await getTenantCtx(db, user.id))) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) await invalidateSession(db, token)
  jar.delete(SESSION_COOKIE)
  return NextResponse.redirect(new URL('/login?error=no-access', request.url))
}
