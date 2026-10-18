import { db } from '@/db/client'
import { tillSignIn } from '@/server/services/till-auth'
import { json, readJson, withDevice } from '@/server/till-api'

/** First sign-in of a person on this till: phone/email, password and PIN. Device token auth. */
export async function POST(request: Request) {
  return withDevice(request, async (device) => {
    const body = (await readJson(request)) as { identifier?: unknown; password?: unknown; pin?: unknown } | null
    const staff = await tillSignIn(db, device, {
      identifier: typeof body?.identifier === 'string' ? body.identifier : '',
      password: typeof body?.password === 'string' ? body.password : '',
      pin: typeof body?.pin === 'string' ? body.pin : '',
    })
    return json({ staff })
  })
}
