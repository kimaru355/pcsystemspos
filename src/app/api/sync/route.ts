import { after } from 'next/server'
import { db } from '@/db/client'
import { deliverDue } from '@/server/services/receipts'
import { sync } from '@/server/services/sync'
import { json, readJson, withDevice } from '@/server/till-api'

/** The till's sync: push operations, pull changed sections. Device token auth. */
export async function POST(request: Request) {
  return withDevice(request, async (device) => {
    const res = await sync(db, device, await readJson(request))
    // Receipts the till asked to send go out once the till has its answer.
    after(() => deliverDue(db).then(() => undefined, (e) => console.error('Message delivery failed:', e)))
    return json(res)
  })
}
