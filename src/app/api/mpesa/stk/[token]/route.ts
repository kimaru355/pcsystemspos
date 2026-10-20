import { db } from '@/db/client'
import { handleStkCallback } from '@/server/services/mpesa'
import { callbackAllowed, mpesaAck } from '@/server/till-api'

/** Safaricom's answer to an STK push. */
export async function POST(request: Request, ctx: RouteContext<'/api/mpesa/stk/[token]'>) {
  if (!callbackAllowed(request)) return new Response(null, { status: 403 })
  const { token } = await ctx.params
  const body = await request.json().catch(() => null)
  try {
    const r = await handleStkCallback(db, token, body)
    if (r === 'unknown') console.warn('M-Pesa STK callback not matched to a request')
  } catch (e) {
    // Safaricom does not retry STK callbacks; log loudly so the payment can be found by hand.
    console.error('M-Pesa STK callback failed:', e, JSON.stringify(body))
    return new Response(null, { status: 500 })
  }
  return mpesaAck()
}
