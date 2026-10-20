import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Public https base URL of the app, used in M-Pesa callback URLs (e.g. https://pos.example.co.ke). */
  APP_URL: optional,
  /** 32 random bytes, base64: encrypts stored M-Pesa credentials. `openssl rand -base64 32` */
  SECRETS_KEY: optional,
  /** Shared secret the cron container sends to /api/internal/cron. */
  CRON_SECRET: optional,
  /** Optional comma-separated list of IPs allowed to call the M-Pesa callbacks. */
  MPESA_CALLBACK_IPS: optional,
  /** Africa's Talking SMS. */
  AT_USERNAME: optional,
  AT_API_KEY: optional,
  AT_SENDER_ID: optional,
  AT_SANDBOX: optional,
  /** SMTP for receipts and digests, e.g. smtp://user:pass@mail.example.co.ke:587 */
  SMTP_URL: optional,
  MAIL_FROM: optional,
})

export type Env = z.infer<typeof schema>

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = schema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid environment: ${details}`)
  }
  return result.data
}

let cached: Env | undefined

/** Parses process.env on first call and memoizes the result. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env)
  return cached
}
