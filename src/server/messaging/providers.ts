import nodemailer from 'nodemailer'
import { getEnv } from '@/env'

/*
 * SMS (Africa's Talking) and email (SMTP via Nodemailer). Each returns null when the server has
 * no credentials for it, so messages simply wait in the queue until it is set up.
 */

export interface SmsSender {
  send(to: string, text: string): Promise<{ providerId: string | null }>
}

export interface EmailSender {
  send(m: { to: string; subject: string; text: string; html: string | null }): Promise<{ providerId: string | null }>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    /** Retrying will not help (a bad number, a rejected address). */
    public permanent = false,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class AfricasTalkingSms implements SmsSender {
  constructor(
    private readonly c: { username: string; apiKey: string; senderId: string | null; sandbox: boolean },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(to: string, text: string) {
    const host = this.c.sandbox ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com'
    const form = new URLSearchParams({ username: this.c.username, to, message: text })
    if (this.c.senderId) form.set('from', this.c.senderId)
    let res: Response
    try {
      res = await this.fetchFn(`${host}/version1/messaging`, {
        method: 'POST',
        headers: { apiKey: this.c.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      })
    } catch {
      throw new ProviderError("Africa's Talking could not be reached.")
    }
    const body = (await res.json().catch(() => null)) as {
      SMSMessageData?: { Recipients?: { status: string; statusCode: number; messageId: string }[]; Message?: string }
    } | null
    const r = body?.SMSMessageData?.Recipients?.[0]
    if (!res.ok || !r) throw new ProviderError(body?.SMSMessageData?.Message ?? `Africa's Talking refused the message (${res.status}).`, res.status === 401)
    // 100 Processed, 101 Sent, 102 Queued; 403 InvalidPhoneNumber etc. are permanent.
    if (r.statusCode >= 400) throw new ProviderError(`SMS not sent: ${r.status}.`, r.statusCode === 403 || r.statusCode === 406)
    return { providerId: r.messageId }
  }
}

export class SmtpEmail implements EmailSender {
  private readonly transport
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url)
  }

  async send(m: { to: string; subject: string; text: string; html: string | null }) {
    try {
      const info = await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) })
      return { providerId: info.messageId ?? null }
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode
      throw new ProviderError(`Email not sent: ${(e as Error).message}`, typeof code === 'number' && code >= 500 && code < 600 && code !== 554)
    }
  }
}

export type Senders = { sms: SmsSender | null; email: EmailSender | null }

/** The senders the server's environment configures (null when not set up). */
export function envSenders(): Senders {
  const env = getEnv()
  return {
    sms:
      env.AT_USERNAME && env.AT_API_KEY
        ? new AfricasTalkingSms({
            username: env.AT_USERNAME,
            apiKey: env.AT_API_KEY,
            senderId: env.AT_SENDER_ID ?? null,
            sandbox: env.AT_SANDBOX === 'true' || env.AT_USERNAME === 'sandbox',
          })
        : null,
    email: env.SMTP_URL && env.MAIL_FROM ? new SmtpEmail(env.SMTP_URL, env.MAIL_FROM) : null,
  }
}
