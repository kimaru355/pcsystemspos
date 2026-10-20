/*
 * A small Safaricom Daraja client: OAuth token, STK push (Lipa na M-Pesa Online) and C2B URL
 * registration, plus parsers for the callbacks Safaricom sends. Amounts at Daraja are whole
 * shillings. `fetch` is injectable for tests.
 */

export type DarajaCredentials = {
  environment: 'sandbox' | 'production'
  shortcodeType: 'paybill' | 'till'
  /** Business/store number (STK password shortcode). */
  shortcode: string
  /** Paybill number, or the till number for buy goods. */
  partyB: string
  consumerKey: string
  consumerSecret: string
  passkey: string
}

export type StkPushResult = { merchantRequestId: string; checkoutRequestId: string; customerMessage: string }

/** What the server needs from M-Pesa; the real client below, a fake in tests. */
export interface MpesaGateway {
  stkPush(i: {
    phone: string
    amountKes: number
    accountReference: string
    description: string
    callbackUrl: string
  }): Promise<StkPushResult>
  registerC2B(i: { confirmationUrl: string; validationUrl: string }): Promise<void>
}

export class DarajaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DarajaError'
  }
}

const BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' }

const stamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Nairobi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** YYYYMMDDHHmmss in Nairobi time, as Daraja wants it. */
export function stkTimestamp(now: Date): string {
  const p = Object.fromEntries(stamp.formatToParts(now).map((x) => [x.type, x.value]))
  return `${p.year}${p.month}${p.day}${p.hour === '24' ? '00' : p.hour}${p.minute}${p.second}`
}

export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64')
}

/** `+254712345678` → `254712345678`. */
export function darajaPhone(e164: string): string {
  return e164.replace(/^\+/, '')
}

/** An order number as an account reference: letters and digits only, at most 12 (KTL01000123). */
export function accountReference(orderNumber: string): string {
  return normalizeReference(orderNumber).slice(0, 12)
}

/** Upper-case letters and digits only, for matching what customers type as the account. */
export function normalizeReference(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const tokens = new Map<string, { token: string; expiresAt: number }>()

export class Daraja implements MpesaGateway {
  constructor(
    private readonly c: DarajaCredentials,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get base() {
    return BASE[this.c.environment]
  }

  private async token(): Promise<string> {
    const key = `${this.c.environment}:${this.c.consumerKey}`
    const hit = tokens.get(key)
    if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token
    const auth = Buffer.from(`${this.c.consumerKey}:${this.c.consumerSecret}`).toString('base64')
    const res = await this.fetchFn(`${this.base}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${auth}` },
    })
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: string } | null
    if (!res.ok || !body?.access_token) {
      throw new DarajaError('M-Pesa refused the credentials. Check the consumer key and secret in Settings.')
    }
    tokens.set(key, { token: body.access_token, expiresAt: Date.now() + Number(body.expires_in ?? 3599) * 1000 })
    return body.access_token
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (e) {
      if (e instanceof DarajaError) throw e
      throw new DarajaError('M-Pesa could not be reached. Try again.')
    }
    const body = (await res.json().catch(() => null)) as (T & { errorMessage?: string; ResponseCode?: string }) | null
    if (!res.ok || !body || (body.ResponseCode !== undefined && body.ResponseCode !== '0')) {
      throw new DarajaError(body?.errorMessage ?? `M-Pesa refused the request (${res.status}).`)
    }
    return body
  }

  async stkPush(i: Parameters<MpesaGateway['stkPush']>[0]): Promise<StkPushResult> {
    const timestamp = stkTimestamp(this.now())
    const body = await this.post<{ MerchantRequestID: string; CheckoutRequestID: string; CustomerMessage?: string }>(
      '/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: this.c.shortcode,
        Password: stkPassword(this.c.shortcode, this.c.passkey, timestamp),
        Timestamp: timestamp,
        TransactionType: this.c.shortcodeType === 'paybill' ? 'CustomerPayBillOnline' : 'CustomerBuyGoodsOnline',
        Amount: i.amountKes,
        PartyA: darajaPhone(i.phone),
        PartyB: this.c.partyB,
        PhoneNumber: darajaPhone(i.phone),
        CallBackURL: i.callbackUrl,
        AccountReference: i.accountReference,
        TransactionDesc: i.description.slice(0, 13),
      },
    )
    return {
      merchantRequestId: body.MerchantRequestID,
      checkoutRequestId: body.CheckoutRequestID,
      customerMessage: body.CustomerMessage ?? '',
    }
  }

  async registerC2B(i: { confirmationUrl: string; validationUrl: string }): Promise<void> {
    await this.post('/mpesa/c2b/v1/registerurl', {
      ShortCode: this.c.partyB,
      ResponseType: 'Completed',
      ConfirmationURL: i.confirmationUrl,
      ValidationURL: i.validationUrl,
    })
  }
}

// ------------------------------------------------------------------ callbacks

export type StkCallback = {
  merchantRequestId: string
  checkoutRequestId: string
  resultCode: number
  resultDesc: string
  amountKes: number | null
  receipt: string | null
  phone: string | null
}

/** Parses `{ Body: { stkCallback: … } }`; null when it is not an STK callback. */
export function parseStkCallback(body: unknown): StkCallback | null {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } } | null)?.Body?.stkCallback
  if (!cb || typeof cb.CheckoutRequestID !== 'string') return null
  const items = ((cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] } | undefined)?.Item ?? [])
  const item = (name: string) => items.find((x) => x.Name === name)?.Value
  const amount = Number(item('Amount'))
  return {
    merchantRequestId: String(cb.MerchantRequestID ?? ''),
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDesc: String(cb.ResultDesc ?? ''),
    amountKes: Number.isFinite(amount) && amount > 0 ? amount : null,
    receipt: item('MpesaReceiptNumber') ? String(item('MpesaReceiptNumber')) : null,
    phone: item('PhoneNumber') ? String(item('PhoneNumber')) : null,
  }
}

export type C2BConfirmation = {
  transId: string
  transType: string | null
  amountKes: number
  billRef: string | null
  msisdn: string | null
  payerName: string | null
  transTime: Date
}

/** `20261018083000` (Nairobi) → Date. */
function parseTransTime(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 3, mi, se))
}

/** Parses a C2B confirmation; null when required fields are missing. */
export function parseC2BConfirmation(body: unknown, now = new Date()): C2BConfirmation | null {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b.TransID !== 'string' || b.TransID.trim() === '') return null
  const amount = Number(b.TransAmount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const name = [b.FirstName, b.MiddleName, b.LastName].filter((x) => typeof x === 'string' && x).join(' ')
  return {
    transId: b.TransID.trim(),
    transType: typeof b.TransactionType === 'string' ? b.TransactionType : null,
    amountKes: amount,
    billRef: typeof b.BillRefNumber === 'string' && b.BillRefNumber.trim() ? b.BillRefNumber.trim() : null,
    msisdn: typeof b.MSISDN === 'string' ? b.MSISDN : null,
    payerName: name || null,
    transTime: (typeof b.TransTime === 'string' && parseTransTime(b.TransTime)) || now,
  }
}
