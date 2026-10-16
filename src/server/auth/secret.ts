import { hash, verify } from '@node-rs/argon2'

/** argon2id with the library defaults. Used for passwords and PINs. */
export function hashSecret(plain: string): Promise<string> {
  return hash(plain)
}

/** Returns false (never throws) for a wrong secret or a malformed hash. */
export async function verifySecret(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain)
  } catch {
    return false
  }
}
