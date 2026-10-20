import { db } from '@/db/client'
import { startStkPush } from '@/server/services/mpesa'
import { json, readJson, withDevice } from '@/server/till-api'

/** Send an STK push for an order of this till's outlet. Device token auth. */
export async function POST(request: Request) {
  return withDevice(request, async (device) => {
    const b = (await readJson(request)) as Record<string, unknown> | null
    const r = await startStkPush(db, device, {
      orderId: String(b?.orderId ?? ''),
      phone: String(b?.phone ?? ''),
      amountCents: Number(b?.amountCents),
      actorId: String(b?.actorId ?? ''),
    })
    return json(r)
  })
}
