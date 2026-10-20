import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getEnv } from '@/env'
import { DomainError } from './errors'

/*
 * AES-256-GCM for credentials kept in the database (M-Pesa consumer key/secret and passkey).
 * Stored as `v1:<iv>:<tag>:<ciphertext>`, base64 parts. The key is SECRETS_KEY (32 bytes, base64).
 */

function key(): Buffer {
  const raw = getEnv().SECRETS_KEY
  const k = raw ? Buffer.from(raw, 'base64') : null
  if (!k || k.length !== 32) {
    throw new DomainError('invalid_input', 'The server has no SECRETS_KEY set, so it cannot store M-Pesa credentials.')
  }
  return k
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(':')
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unreadable stored secret')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}
