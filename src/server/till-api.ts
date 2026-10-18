import { db } from '@/db/client'
import type { TillApiError } from '@/domain/till-data'
import { getCurrentUser } from '@/server/auth/current-user'
import { DomainError, type DomainErrorCode } from '@/server/errors'
import { authenticateDevice, type DeviceAuth } from '@/server/services/devices'
import { getTenantCtx, type TenantCtx } from '@/server/tenant'

/* Helpers for the till's JSON API (route handlers under /api). */

const STATUS: Record<DomainErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  duplicate_code: 409,
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export function apiError(error: string, message: string, status: number): Response {
  return json({ error, message } satisfies TillApiError, status)
}

/** Map a thrown error to a response: DomainErrors to their status, anything else to 500. */
export function errorResponse(e: unknown): Response {
  if (e instanceof DomainError) return apiError(e.code, e.message, STATUS[e.code])
  console.error('Till API error:', e)
  return apiError('server_error', 'Something went wrong on the server. The till will try again.', 500)
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new DomainError('invalid_input', 'The request body is not JSON.')
  }
}

/** Run `fn` for the device named by the Bearer token; 401 for an unknown or revoked device. */
export async function withDevice(request: Request, fn: (device: DeviceAuth) => Promise<Response>): Promise<Response> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  try {
    const auth = await authenticateDevice(db, token)
    if (!auth.ok) {
      const message =
        auth.reason === 'revoked'
          ? 'This till was revoked by an owner or manager. Its unsynced sales are kept on this device.'
          : auth.reason === 'suspended'
            ? 'This business is suspended. Contact the platform.'
            : 'This till is not registered.'
      return apiError(auth.reason === 'unknown' ? 'unregistered' : auth.reason, message, 401)
    }
    return await fn(auth.device)
  } catch (e) {
    return errorResponse(e)
  }
}

/** Run `fn` for the signed-in web user's tenant (cookie session); 401 when signed out. */
export async function withTenant(fn: (ctx: TenantCtx, userName: string) => Promise<Response>): Promise<Response> {
  try {
    const user = await getCurrentUser()
    if (!user) return apiError('signed_out', 'Sign in first.', 401)
    if (user.mustChangePassword) return apiError('password_change', 'Change your temporary password first.', 403)
    const ctx = await getTenantCtx(db, user.id)
    if (!ctx) return apiError('no_access', 'Your account has no access to a business.', 403)
    return await fn(ctx, user.name)
  } catch (e) {
    return errorResponse(e)
  }
}
