import { db } from '@/db/client'
import { can } from '@/domain/permissions'
import { registerDevice } from '@/server/services/devices'
import { listOutlets } from '@/server/services/outlets'
import { apiError, json, readJson, withTenant } from '@/server/till-api'

/**
 * Registering this browser as a till needs an owner or manager signed in on the web
 * (cookie session). GET lists the outlets they may register a till for.
 */
export async function GET() {
  return withTenant(async (ctx, userName) => {
    if (!can(ctx.role, 'device.manage')) {
      return apiError('forbidden', 'Only an owner or manager can set up a till.', 403)
    }
    const outlets = (await listOutlets(db, ctx)).filter((o) => o.active)
    return json({ userName, outlets: outlets.map((o) => ({ id: o.id, code: o.code, name: o.name })) })
  })
}

export async function POST(request: Request) {
  return withTenant(async (ctx) => {
    const body = (await readJson(request)) as { outletId?: unknown; name?: unknown } | null
    const r = await registerDevice(db, ctx, {
      outletId: typeof body?.outletId === 'string' ? body.outletId : '',
      name: typeof body?.name === 'string' ? body.name : '',
    })
    return json({ token: r.token, deviceId: r.deviceId, code: r.code })
  })
}
