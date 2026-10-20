import { db } from '@/db/client'
import { stkStatus } from '@/server/services/mpesa'
import { json, withDevice } from '@/server/till-api'

/** Where an STK push stands. Device token auth. */
export async function GET(request: Request, ctx: RouteContext<'/api/till/mpesa/stk/[id]'>) {
  return withDevice(request, async (device) => json(await stkStatus(db, device, (await ctx.params).id)))
}
