import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { messageOutbox, receipts } from '@/db/schema'
import type { Op } from '@/domain/sync-ops'
import { ProviderError, type Senders } from '@/server/messaging/providers'
import { deliverDue, messagesForOrder, resendReceipt, smsUsage } from '@/server/services/receipts'
import { applyOp } from '@/server/services/sync'
import { resetDb } from '../helpers/db'
import { checkoutOp, collectionOp, paymentOp, tillWorld, uuid, type TillWorld } from './till-helpers'

function sendOp(w: TillWorld, orderId: string, sourceId: string | null, channel: 'sms' | 'email', to: string): Op {
  return {
    id: uuid(),
    type: 'receipt.send',
    actorId: w.cashier.membershipId,
    occurredAt: new Date().toISOString(),
    payload: { orderId, sourceId, channel, to },
  }
}

function fakeSenders() {
  const sms: { to: string; text: string }[] = []
  const email: { to: string; subject: string; text: string }[] = []
  let failNext: ProviderError | null = null
  const senders: Senders = {
    sms: {
      async send(to, text) {
        if (failNext) {
          const e = failNext
          failNext = null
          throw e
        }
        sms.push({ to, text })
        return { providerId: `ATX${sms.length}` }
      },
    },
    email: {
      async send(m) {
        email.push(m)
        return { providerId: `<${email.length}@test>` }
      },
    },
  }
  return { senders, sms, email, fail: (e: ProviderError) => (failNext = e) }
}

describe('receipts', () => {
  beforeEach(resetDb)

  it('issues a receipt for each payment and collection, with a VAT breakdown and no KRA number yet', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { cashCents: 156000 })
    await applyOp(db, w.device, op)
    const rows = await db.select().from(receipts).where(eq(receipts.orderId, op.payload.order.id))
    expect(rows.map((r) => r.kind).sort()).toEqual(['collection', 'order'])
    expect(rows.every((r) => r.kraInvoiceNumber === null)).toBe(true)
    expect(rows[0].taxBreakdown).toEqual([{ category: 'B', rateBp: 1600, grossCents: 156000, vatCents: 21517 }])
  })

  it('issues an order receipt for an unpaid sale, then one per later payment and collection', async () => {
    const w = await tillWorld()
    const op = checkoutOp(w, { collect: 'none', customer: { name: 'P', phone: '0712345678' } })
    await applyOp(db, w.device, op)
    const orderId = op.payload.order.id
    await applyOp(db, w.device, paymentOp(w, orderId, 156000))
    await applyOp(db, w.device, collectionOp(w, orderId, [{ lineId: op.payload.order.lines[0].id, qtyMilli: 1000 }]))
    const rows = await db.select().from(receipts).where(eq(receipts.orderId, orderId))
    expect(rows.map((r) => [r.kind, r.sourceId === null]).sort()).toEqual([
      ['collection', false],
      ['order', false],
      ['order', true],
    ])
  })
})

describe('sending receipts', () => {
  beforeEach(resetDb)

  async function sale(w: TillWorld) {
    const op = checkoutOp(w, { cashCents: 156000 })
    await applyOp(db, w.device, op)
    return { orderId: op.payload.order.id, paymentId: op.payload.payments[0].id }
  }

  it('queues an SMS from the till and delivers it once, counting its parts', async () => {
    const w = await tillWorld()
    const { orderId, paymentId } = await sale(w)
    const op = sendOp(w, orderId, paymentId, 'sms', '0712 345 678')
    expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'applied' })
    expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'applied' })
    const f = fakeSenders()
    expect(await deliverDue(db, f.senders)).toEqual({ sent: 1, failed: 0, waiting: 0 })
    expect(await deliverDue(db, f.senders)).toEqual({ sent: 0, failed: 0, waiting: 0 })
    expect(f.sms).toHaveLength(1)
    expect(f.sms[0].to).toBe('+254712345678')
    expect(f.sms[0].text).toContain('Paid KES 1,560.00 Cash.')
    expect(await smsUsage(db, w.owner, new Date(0))).toEqual({ messages: 1, segments: 1 })
    expect((await messagesForOrder(db, w.owner, orderId))[0]).toMatchObject({ channel: 'sms', status: 'sent' })
  })

  it('emails the 48-column receipt as text and HTML', async () => {
    const w = await tillWorld()
    const { orderId } = await sale(w)
    await applyOp(db, w.device, sendOp(w, orderId, null, 'email', 'Peter@Example.com'))
    const f = fakeSenders()
    await deliverDue(db, f.senders)
    expect(f.email[0]).toMatchObject({ to: 'peter@example.com', subject: expect.stringContaining('Receipt KTL-01-') })
    expect(f.email[0].text).toContain('TOTAL')
  })

  it('refuses a bad address as a rejected op', async () => {
    const w = await tillWorld()
    const { orderId } = await sale(w)
    expect(await applyOp(db, w.device, sendOp(w, orderId, null, 'sms', '123'))).toMatchObject({ status: 'rejected', code: 'invalid_input' })
  })

  it('waits while SMS is not set up, retries a failure, and gives up on a permanent one', async () => {
    const w = await tillWorld()
    const { orderId } = await sale(w)
    await applyOp(db, w.device, sendOp(w, orderId, null, 'sms', '0712345678'))
    expect(await deliverDue(db, { sms: null, email: null })).toEqual({ sent: 0, failed: 0, waiting: 1 })
    let [m] = await db.select().from(messageOutbox)
    expect(m).toMatchObject({ status: 'queued', attempts: 0, lastError: 'SMS is not set up on the server.' })

    const f = fakeSenders()
    const later = new Date(Date.now() + 60 * 60_000)
    f.fail(new ProviderError('timeout'))
    expect(await deliverDue(db, f.senders, later)).toEqual({ sent: 0, failed: 0, waiting: 1 })
    ;[m] = await db.select().from(messageOutbox)
    expect(m).toMatchObject({ status: 'queued', attempts: 1 })
    f.fail(new ProviderError('InvalidPhoneNumber', true))
    expect(await deliverDue(db, f.senders, new Date(later.getTime() + 60 * 60_000))).toEqual({ sent: 0, failed: 1, waiting: 0 })
    ;[m] = await db.select().from(messageOutbox)
    expect(m).toMatchObject({ status: 'failed', attempts: 2 })
  })

  it('lets an admin resend, within their outlets only', async () => {
    const w = await tillWorld()
    const { orderId, paymentId } = await sale(w)
    await resendReceipt(db, w.manager.ctx, orderId, { sourceId: paymentId, channel: 'sms', to: '0712345678' })
    expect(await db.select().from(messageOutbox)).toHaveLength(1)
    await expect(
      resendReceipt(db, w.owner, orderId, { sourceId: uuid(), channel: 'sms', to: '0712345678' }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const { updateStaff } = await import('@/server/services/staff')
    await updateStaff(db, w.owner, w.manager.membershipId, { outletIds: [w.eld] })
    const { getTenantCtx } = await import('@/server/tenant')
    const ctx = (await getTenantCtx(db, w.manager.userId))!
    await expect(resendReceipt(db, ctx, orderId, { sourceId: null, channel: 'sms', to: '0712345678' })).rejects.toMatchObject({
      code: 'forbidden',
    })
  })
})
