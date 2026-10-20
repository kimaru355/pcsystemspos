import { db } from '@/db/client'
import { handleC2BConfirmation } from '@/server/services/mpesa'
import { callbackAllowed, mpesaAck } from '@/server/till-api'

/** A paybill/till payment confirmed by Safaricom. */
export async function POST(request: Request, ctx: RouteContext<'/api/mpesa/c2b/[token]/confirmation'>) {
  if (!callbackAllowed(request)) return new Response(null, { status: 403 })
  const { token } = await ctx.params
  const body = await request.json().catch(() => null)
  try {
    const r = await handleC2BConfirmation(db, token, body)
    if (r === 'unknown') return new Response(null, { status: 404 })
  } catch (e) {
    console.error('M-Pesa C2B confirmation failed:', e, JSON.stringify(body))
    // A non-2xx answer makes Safaricom try again later.
    return new Response(null, { status: 500 })
  }
  return mpesaAck()
}
