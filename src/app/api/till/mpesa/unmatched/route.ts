import { db } from '@/db/client'
import { listUnmatchedForTill } from '@/server/services/mpesa'
import { json, withDevice } from '@/server/till-api'

/** M-Pesa payments waiting to be attached to an order. Device token auth. */
export async function GET(request: Request) {
  return withDevice(request, async (device) => json({ payments: await listUnmatchedForTill(db, device) }))
}
