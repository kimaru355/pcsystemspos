import { db } from '@/db/client'
import { sync } from '@/server/services/sync'
import { json, readJson, withDevice } from '@/server/till-api'

/** The till's sync: push operations, pull changed sections. Device token auth. */
export async function POST(request: Request) {
  return withDevice(request, async (device) => json(await sync(db, device, await readJson(request))))
}
