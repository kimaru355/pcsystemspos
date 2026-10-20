import { parseArgs } from 'node:util'

// Load .env before anything touches DATABASE_URL (the db client reads it on first use).
try {
  process.loadEnvFile?.()
} catch {
  // No .env file: rely on the real environment.
}

const USAGE = `Usage:
  npm run platform -- create-admin --name <name> --email <email> [--actor <admin email>]
  npm run platform -- create-business --name <name> --owner-name <name>
      (--owner-email <email> | --owner-phone <phone>) [--actor <admin email>]

The password (a temporary one: it must be changed at first sign-in) is read from standard input,
so it never lands in the shell history:
  printf '%s' "$PASSWORD" | npm run platform -- create-admin ...
or typed at the prompt. --password / --owner-password still work but are visible to other users
of the machine. --actor names the platform admin doing this, for the audit log.`

class UsageError extends Error {}

function required(values: Record<string, string | boolean | undefined>, key: string): string {
  const v = values[key]
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`Missing --${key}`)
  return v
}

/** The password from the flag, else from standard input (piped, or typed without echo). */
async function readPassword(flag: string | undefined, prompt: string): Promise<string> {
  if (flag) return flag
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let data = ''
    for await (const chunk of stdin) data += chunk
    return data.replace(/\r?\n$/, '')
  }
  process.stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let value = ''
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.off('data', onData)
        process.stdout.write('\n')
        resolve(value)
      } else if (ch === '\u0003') {
        process.exit(130)
      } else if (ch === '\u007f') {
        value = value.slice(0, -1)
      } else {
        value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      password: { type: 'string' },
      actor: { type: 'string' },
      'owner-name': { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-phone': { type: 'string' },
      'owner-password': { type: 'string' },
    },
  })
  const [command] = positionals
  if (command !== 'create-admin' && command !== 'create-business') {
    throw new UsageError(command ? `Unknown command "${command}"` : 'Missing command')
  }
  const { db } = await import('../src/db/client')
  const { createBusinessWithOwner, createPlatformAdmin, platformAdminByEmail } = await import(
    '../src/server/services/platform'
  )
  const actorUserId = values.actor ? await platformAdminByEmail(db, values.actor) : undefined

  if (command === 'create-admin') {
    const name = required(values, 'name')
    const email = required(values, 'email')
    const password = await readPassword(values.password, 'Temporary password: ')
    const { userId } = await createPlatformAdmin(db, { name, email, password, actorUserId })
    console.log(`Created platform admin. userId=${userId}`)
    console.log('They must change the temporary password at first sign-in.')
  } else {
    const name = required(values, 'name')
    const ownerName = required(values, 'owner-name')
    const ownerPassword = await readPassword(values['owner-password'], "Owner's temporary password: ")
    const { businessId, ownerUserId } = await createBusinessWithOwner(db, {
      name,
      ownerName,
      ownerEmail: values['owner-email'],
      ownerPhone: values['owner-phone'],
      ownerPassword,
      actorUserId,
    })
    console.log(`Created business. businessId=${businessId} ownerUserId=${ownerUserId}`)
    console.log('The owner must change the temporary password at first sign-in.')
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (e: unknown) => {
    const { DomainError } = await import('../src/server/errors')
    if (e instanceof UsageError) {
      console.error(`${e.message}\n\n${USAGE}`)
    } else if (e instanceof DomainError) {
      console.error(`Error (${e.code}): ${e.message}`)
    } else if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
      console.error(`${e.message}\n\n${USAGE}`)
    } else {
      console.error(e)
    }
    process.exit(1)
  })
