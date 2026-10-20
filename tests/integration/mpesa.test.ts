import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client'
import { auditLog, mpesaConfigs, mpesaRequests, mpesaTransactions, payments } from '@/db/schema'
import { stkTimestamp, type MpesaGateway } from '@/server/mpesa/daraja'
import {
  attachForAdmin,
  attachForTill,
  getMpesaSettings,
  handleC2BConfirmation,
  handleStkCallback,
  listUnmatchedForAdmin,
  registerC2BUrls,
  saveMpesaConfig,
  startStkPush,
  stkStatus,
  timeoutStalePushes,
  type MpesaDeps,
} from '@/server/services/mpesa'
import { getOrder } from '@/server/services/orders'
import { applyOp, sync } from '@/server/services/sync'
import { resetDb } from '../helpers/db'
import { checkoutOp, CLOCK, tillWorld, type TillWorld } from './till-helpers'

type Sent = Parameters<MpesaGateway['stkPush']>[0]

function fakeGateway() {
  const pushes: Sent[] = []
  const registered: { confirmationUrl: string; validationUrl: string }[] = []
  let n = 0
  const deps: MpesaDeps = {
    gateway: () => ({
      async stkPush(i) {
        pushes.push(i)
        n += 1
        return { merchantRequestId: `m-${n}`, checkoutRequestId: `ws_CO_${n}`, customerMessage: 'Success. Request accepted' }
      },
      async registerC2B(i) {
        registered.push(i)
      },
    }),
  }
  return { deps, pushes, registered }
}

const CONFIG = {
  outletId: null,
  environment: 'sandbox' as const,
  shortcodeType: 'paybill' as const,
  shortcode: '174379',
  partyB: '174379',
  consumerKey: 'key',
  consumerSecret: 'secret',
  passkey: 'passkey',
  active: true,
}

async function openOrder(w: TillWorld, cash = 0) {
  const op = checkoutOp(w, { cashCents: cash || undefined, collect: 'none', customer: { name: 'Peter', phone: '0712345678' } })
  expect(await applyOp(db, w.device, op)).toMatchObject({ status: 'applied' })
  return op.payload.order
}

function stkCallback(checkoutRequestId: string, ok: boolean, receipt = 'SJK1234XYZ', amount = 1560) {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-1',
        CheckoutRequestID: checkoutRequestId,
        ResultCode: ok ? 0 : 1032,
        ResultDesc: ok ? 'The service request is processed successfully.' : 'Request cancelled by user',
        ...(ok
          ? {
              CallbackMetadata: {
                Item: [
                  { Name: 'Amount', Value: amount },
                  { Name: 'MpesaReceiptNumber', Value: receipt },
                  { Name: 'TransactionDate', Value: 20261020103000 },
                  { Name: 'PhoneNumber', Value: 254712345678 },
                ],
              },
            }
          : {}),
      },
    },
  }
}

function c2b(transId: string, billRef: string, amount = '1560.00') {
  return {
    TransactionType: 'Pay Bill',
    TransID: transId,
    TransTime: stkTimestamp(new Date(Date.now() + 1000)),
    TransAmount: amount,
    BusinessShortCode: '174379',
    BillRefNumber: billRef,
    MSISDN: '254712345678',
    FirstName: 'PETER',
    LastName: 'WAFULA',
  }
}

async function token(businessId: string) {
  const [c] = await db.select().from(mpesaConfigs).where(eq(mpesaConfigs.businessId, businessId))
  return c.callbackToken
}

describe('M-Pesa settings', () => {
  beforeEach(resetDb)

  it('stores credentials encrypted, never returns them, and keeps them when left blank', async () => {
    const w = await tillWorld()
    const saved = await saveMpesaConfig(db, w.owner, CONFIG)
    expect(saved).not.toHaveProperty('consumerKey')
    expect(saved.confirmationUrl).toMatch(/^https:\/\/pos\.test\/api\/mpesa\/c2b\/.+\/confirmation$/)
    const [row] = await db.select().from(mpesaConfigs)
    expect(row.consumerKeyEnc).not.toContain('key')
    await saveMpesaConfig(db, w.owner, { ...CONFIG, consumerKey: '', consumerSecret: '', passkey: '', shortcode: '600000', partyB: '' })
    const [after] = await db.select().from(mpesaConfigs)
    expect(after).toMatchObject({ consumerKeyEnc: row.consumerKeyEnc, shortcode: '600000', partyB: '600000' })
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'mpesa.config'))
    expect(JSON.stringify(audit.data)).not.toContain('secret')
    expect((await getMpesaSettings(db, w.owner)).configs).toHaveLength(1)
  })

  it('is for owners only, needs every credential on creation, and checks the codes', async () => {
    const w = await tillWorld()
    await expect(saveMpesaConfig(db, w.manager.ctx, CONFIG)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(saveMpesaConfig(db, w.owner, { ...CONFIG, passkey: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(saveMpesaConfig(db, w.owner, { ...CONFIG, shortcode: '12' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('registers the confirmation URL with Safaricom', async () => {
    const w = await tillWorld()
    const saved = await saveMpesaConfig(db, w.owner, CONFIG)
    const g = fakeGateway()
    await registerC2BUrls(db, w.owner, saved.id, g.deps)
    expect(g.registered[0].confirmationUrl).toBe(saved.confirmationUrl)
    expect((await getMpesaSettings(db, w.owner)).configs[0].c2bRegisteredAt).toBeInstanceOf(Date)
  })

  it('tells the till whether its outlet can take M-Pesa; an outlet override wins', async () => {
    const w = await tillWorld()
    expect((await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })).settings.mpesa).toBe(false)
    await saveMpesaConfig(db, w.owner, { ...CONFIG, active: false })
    await saveMpesaConfig(db, w.owner, { ...CONFIG, outletId: w.ktl, shortcode: '600111', partyB: '600111' })
    expect((await sync(db, w.device, { ops: [], hashes: {}, clock: CLOCK })).settings.mpesa).toBe(true)
  })
})

describe('STK push', () => {
  beforeEach(resetDb)

  async function setup() {
    const w = await tillWorld()
    await saveMpesaConfig(db, w.owner, CONFIG)
    const order = await openOrder(w)
    return { w, order, g: fakeGateway() }
  }

  it('sends the push with the order as account reference and records the payment from the callback', async () => {
    const { w, order, g } = await setup()
    const r = await startStkPush(db, w.device, { orderId: order.id, phone: '0712 345 678', amountCents: 156000, actorId: w.cashier.membershipId }, g.deps)
    expect(r.status).toBe('pending')
    expect(g.pushes[0]).toMatchObject({ phone: '+254712345678', amountKes: 1560, accountReference: order.number.replace(/-/g, '') })
    expect(g.pushes[0].callbackUrl).toMatch(/^https:\/\/pos\.test\/api\/mpesa\/stk\//)

    const t = await token(w.businessId)
    expect(await handleStkCallback(db, t, stkCallback('ws_CO_1', true))).toBe('ok')
    expect(await handleStkCallback(db, t, stkCallback('ws_CO_1', true))).toBe('ok') // repeated
    expect((await stkStatus(db, w.device, r.id)).status).toBe('success')
    const d = await getOrder(db, w.owner, order.id)
    expect(d.state.paidCents).toBe(156000)
    const pays = await db.select().from(payments).where(eq(payments.method, 'mpesa'))
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ reference: 'SJK1234XYZ', actorUserId: w.cashier.userId, deviceId: w.device.deviceId })
  })

  it('a cancelled push is a failure and records nothing', async () => {
    const { w, order, g } = await setup()
    const r = await startStkPush(db, w.device, { orderId: order.id, phone: '0712345678', amountCents: 100000, actorId: w.cashier.membershipId }, g.deps)
    await handleStkCallback(db, await token(w.businessId), stkCallback('ws_CO_1', false))
    expect(await stkStatus(db, w.device, r.id)).toMatchObject({ status: 'failed', message: 'Request cancelled by user' })
    expect(await db.select().from(payments).where(eq(payments.method, 'mpesa'))).toHaveLength(0)
  })

  it('times out with no answer, but a late success still pays', async () => {
    const { w, order, g } = await setup()
    const r = await startStkPush(db, w.device, { orderId: order.id, phone: '0712345678', amountCents: 100000, actorId: w.cashier.membershipId }, g.deps)
    const later = new Date(Date.now() + 3 * 60_000)
    expect((await stkStatus(db, w.device, r.id, later)).status).toBe('timeout')
    expect(await timeoutStalePushes(db, later)).toBe(0)
    await handleStkCallback(db, await token(w.businessId), stkCallback('ws_CO_1', true, 'SJK999', 1000))
    expect((await stkStatus(db, w.device, r.id)).status).toBe('success')
    expect((await getOrder(db, w.owner, order.id)).state.paidCents).toBe(100000)
  })

  it('refuses fractions of a shilling, unknown orders, other outlets and no settings', async () => {
    const { w, order, g } = await setup()
    const base = { orderId: order.id, phone: '0712345678', amountCents: 100050, actorId: w.cashier.membershipId }
    await expect(startStkPush(db, w.device, base, g.deps)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      startStkPush(db, w.device, { ...base, amountCents: 1000, orderId: crypto.randomUUID() }, g.deps),
    ).rejects.toMatchObject({ code: 'not_found' })
    await db.update(mpesaConfigs).set({ active: false })
    await expect(startStkPush(db, w.device, { ...base, amountCents: 1000 }, g.deps)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('ignores callbacks with an unknown token', async () => {
    const { w, order, g } = await setup()
    await startStkPush(db, w.device, { orderId: order.id, phone: '0712345678', amountCents: 1000, actorId: w.cashier.membershipId }, g.deps)
    expect(await handleStkCallback(db, 'wrong', stkCallback('ws_CO_1', true))).toBe('unknown')
    expect((await db.select().from(mpesaRequests))[0].status).toBe('pending')
  })
})

describe('paybill payments (C2B)', () => {
  beforeEach(resetDb)

  it('matches an account reference typed with or without hyphens, once', async () => {
    const w = await tillWorld()
    await saveMpesaConfig(db, w.owner, CONFIG)
    const order = await openOrder(w)
    const t = await token(w.businessId)
    const ref = order.number.replace(/-/g, '').toLowerCase()
    expect(await handleC2BConfirmation(db, t, c2b('SJK0001', ref, '500.00'))).toBe('ok')
    expect(await handleC2BConfirmation(db, t, c2b('SJK0001', ref, '500.00'))).toBe('ok')
    expect((await getOrder(db, w.owner, order.id)).state.paidCents).toBe(50000)
    const [txn] = await db.select().from(mpesaTransactions)
    expect(txn).toMatchObject({ status: 'matched', orderId: order.id })
    const d = await getOrder(db, w.owner, order.id)
    expect(d.state.events[0]).toMatchObject({ kind: 'payment', method: 'mpesa', by: 'M-Pesa' })
  })

  it('keeps a payment with an unknown reference unmatched until someone attaches it', async () => {
    const w = await tillWorld()
    await saveMpesaConfig(db, w.owner, CONFIG)
    const order = await openOrder(w)
    await handleC2BConfirmation(db, await token(w.businessId), c2b('SJK0002', 'cement', '1000'))
    const [u] = await listUnmatchedForAdmin(db, w.owner)
    expect(u).toMatchObject({ transId: 'SJK0002', amountCents: 100000, msisdn: '…5678', payerName: 'PETER WAFULA' })

    await expect(attachForAdmin(db, w.owner, u.id, 'KTL-99-000001')).rejects.toMatchObject({ code: 'not_found' })
    const r = await attachForTill(db, w.device, { transactionId: u.id, orderId: order.id, actorId: w.cashier.membershipId })
    expect(r.orderNumber).toBe(order.number)
    expect((await getOrder(db, w.owner, order.id)).state.paidCents).toBe(100000)
    expect(await listUnmatchedForAdmin(db, w.owner)).toHaveLength(0)
    await expect(attachForAdmin(db, w.owner, u.id, order.number)).rejects.toMatchObject({ code: 'conflict' })
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'mpesa.attach'))).toHaveLength(1)
  })

  it('a till number payment (no account) is always unmatched', async () => {
    const w = await tillWorld()
    await saveMpesaConfig(db, w.owner, { ...CONFIG, shortcodeType: 'till', partyB: '5123456' })
    const order = await openOrder(w)
    await handleC2BConfirmation(db, await token(w.businessId), c2b('SJK0003', order.number))
    expect((await db.select().from(mpesaTransactions))[0].status).toBe('unmatched')
  })

  it('a manager cannot attach to an order of an outlet outside their scope', async () => {
    const w = await tillWorld()
    await saveMpesaConfig(db, w.owner, CONFIG)
    const order = await openOrder(w)
    await handleC2BConfirmation(db, await token(w.businessId), c2b('SJK0004', 'x'))
    const [u] = await listUnmatchedForAdmin(db, w.owner)
    const { updateStaff } = await import('@/server/services/staff')
    await updateStaff(db, w.owner, w.manager.membershipId, { outletIds: [w.eld] })
    const { getTenantCtx } = await import('@/server/tenant')
    const ctx = (await getTenantCtx(db, w.manager.userId))!
    await expect(attachForAdmin(db, ctx, u.id, order.number)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
