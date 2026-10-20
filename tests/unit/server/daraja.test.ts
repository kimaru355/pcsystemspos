import { describe, expect, it, vi } from 'vitest'
import {
  accountReference,
  Daraja,
  DarajaError,
  parseC2BConfirmation,
  parseStkCallback,
  stkPassword,
  stkTimestamp,
} from '@/server/mpesa/daraja'

const creds = {
  environment: 'sandbox' as const,
  shortcodeType: 'till' as const,
  shortcode: '174379',
  partyB: '5123456',
  consumerKey: `ck-${Math.random()}`,
  consumerSecret: 'cs',
  passkey: 'pk',
}

describe('Daraja helpers', () => {
  it('formats the timestamp in Nairobi time', () => {
    expect(stkTimestamp(new Date('2026-10-20T07:05:09Z'))).toBe('20261020100509')
    expect(stkTimestamp(new Date('2026-10-20T21:00:00Z'))).toBe('20261021000000')
  })

  it('builds the STK password and the account reference', () => {
    expect(Buffer.from(stkPassword('174379', 'pk', '20261020100509'), 'base64').toString()).toBe('174379pk20261020100509')
    expect(accountReference('KTL-03-000123')).toBe('KTL03000123')
    expect(accountReference('ABCDE-03-000123')).toHaveLength(12)
  })

  it('parses an STK callback, success and failure', () => {
    const ok = parseStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: 'm',
          CheckoutRequestID: 'c',
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: { Item: [{ Name: 'Amount', Value: 10 }, { Name: 'MpesaReceiptNumber', Value: 'R1' }] },
        },
      },
    })
    expect(ok).toMatchObject({ checkoutRequestId: 'c', resultCode: 0, amountKes: 10, receipt: 'R1' })
    expect(parseStkCallback({ Body: { stkCallback: { CheckoutRequestID: 'c', ResultCode: 1032 } } })).toMatchObject({
      resultCode: 1032,
      receipt: null,
    })
    expect(parseStkCallback({ nope: 1 })).toBeNull()
  })

  it('parses a C2B confirmation and refuses one without an id or amount', () => {
    const c = parseC2BConfirmation({ TransID: 'X1', TransAmount: '150.50', TransTime: '20261020100000', BillRefNumber: ' ktl ' })
    expect(c).toMatchObject({ transId: 'X1', amountKes: 150.5, billRef: 'ktl' })
    expect(c?.transTime.toISOString()).toBe('2026-10-20T07:00:00.000Z')
    expect(parseC2BConfirmation({ TransID: '', TransAmount: '1' })).toBeNull()
    expect(parseC2BConfirmation({ TransID: 'X', TransAmount: '0' })).toBeNull()
  })
})

describe('Daraja client', () => {
  it('gets a token, then sends a buy-goods STK push to the till number', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/oauth/')) return Response.json({ access_token: 'tok', expires_in: '3599' })
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
      return Response.json({ MerchantRequestID: 'm', CheckoutRequestID: 'c', ResponseCode: '0', CustomerMessage: 'ok' })
    })
    const d = new Daraja(creds, fetchFn as typeof fetch, () => new Date('2026-10-20T07:00:00Z'))
    const r = await d.stkPush({ phone: '+254712345678', amountKes: 100, accountReference: 'KTL01000001', description: 'Payment', callbackUrl: 'https://x/cb' })
    expect(r).toEqual({ merchantRequestId: 'm', checkoutRequestId: 'c', customerMessage: 'ok' })
    const body = JSON.parse(String((fetchFn.mock.calls[1] as [string, RequestInit])[1].body))
    expect(body).toMatchObject({
      BusinessShortCode: '174379',
      TransactionType: 'CustomerBuyGoodsOnline',
      PartyA: '254712345678',
      PartyB: '5123456',
      Amount: 100,
      Timestamp: '20261020100000',
    })
    expect(String(fetchFn.mock.calls[0][0])).toContain('sandbox.safaricom.co.ke')
  })

  it('turns a refusal into a DarajaError with Safaricom message', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('/oauth/')
        ? Response.json({ access_token: 'tok2', expires_in: '3599' })
        : Response.json({ errorMessage: 'Invalid PhoneNumber' }, { status: 400 }),
    )
    const d = new Daraja({ ...creds, consumerKey: `other-${Math.random()}` }, fetchFn as typeof fetch)
    await expect(
      d.stkPush({ phone: '+254700000000', amountKes: 1, accountReference: 'A', description: 'P', callbackUrl: 'u' }),
    ).rejects.toEqual(new DarajaError('Invalid PhoneNumber'))
  })
})
