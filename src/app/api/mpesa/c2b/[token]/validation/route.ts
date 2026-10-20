import { callbackAllowed, mpesaAck } from '@/server/till-api'

/** Every payment is accepted; matching to an order happens on confirmation. */
export async function POST(request: Request) {
  if (!callbackAllowed(request)) return new Response(null, { status: 403 })
  return mpesaAck()
}
