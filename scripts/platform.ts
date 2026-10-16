import { parseArgs } from 'node:util'

// Load .env before anything touches DATABASE_URL (the db client reads it on import).
try {
  process.loadEnvFile?.()
} catch {
  // No .env file: rely on the real environment.
}

const USAGE = `Usage:
  npm run platform -- create-admin --name <name> --email <email> --password <password>
  npm run platform -- create-business --name <name> --owner-name <name>
      (--owner-email <email> | --owner-phone <phone>) --owner-password <temporary password>`

class UsageError extends Error {}

function required(values: Record<string, string | boolean | undefined>, key: string): string {
  const v = values[key]
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`Missing --${key}`)
  return v
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      email: { type: 'string' },
      password: { type: 'string' },
      'owner-name': { type: 'string' },
      'owner-email': { type: 'string' },
      'owner-phone': { type: 'string' },
      'owner-password': { type: 'string' },
    },
  })
  const [command] = positionals
  const { db } = await import('../src/db/client')
  const { createBusinessWithOwner, createPlatformAdmin } = await import(
    '../src/server/services/platform'
  )

  if (command === 'create-admin') {
    const { userId } = await createPlatformAdmin(db, {
      name: required(values, 'name'),
      email: required(values, 'email'),
      password: required(values, 'password'),
    })
    console.log(`Created platform admin. userId=${userId}`)
  } else if (command === 'create-business') {
    const { businessId, ownerUserId } = await createBusinessWithOwner(db, {
      name: required(values, 'name'),
      ownerName: required(values, 'owner-name'),
      ownerEmail: values['owner-email'],
      ownerPhone: values['owner-phone'],
      ownerPassword: required(values, 'owner-password'),
    })
    console.log(`Created business. businessId=${businessId} ownerUserId=${ownerUserId}`)
    console.log('The owner must change the temporary password at first login.')
  } else {
    throw new UsageError(command ? `Unknown command "${command}"` : 'Missing command')
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
