import { db } from '@/db/client'
import { attachForTill } from '@/server/services/mpesa'
import { json, readJson, withDevice } from '@/server/till-api'

/** Attach an unmatched M-Pesa payment to an order of this outlet. Device token auth. */
export async function POST(request: Request) {
  return withDevice(request, async (device) => {
    const b = (await readJson(request)) as Record<string, unknown> | null
    const r = await attachForTill(db, device, {
      transactionId: String(b?.transactionId ?? ''),
      orderId: String(b?.orderId ?? ''),
      actorId: String(b?.actorId ?? ''),
    })
    return json(r)
  })
}
