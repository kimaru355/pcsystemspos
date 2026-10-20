import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../env'
import * as schema from './schema'

function createPool(): Pool {
  const pool = new Pool({ connectionString: getEnv().DATABASE_URL })
  // An idle client erroring (e.g. the server restarting) must not crash the process.
  pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message)
  })
  return pool
}

// In development, HMR re-evaluates this module; reuse one Pool instead of leaking one per reload.
const globalForPool = globalThis as unknown as { __posPgPool?: Pool }

function getPool(): Pool {
  if (process.env.NODE_ENV === 'production') return createPool()
  return (globalForPool.__posPgPool ??= createPool())
}

function createDb() {
  return drizzle(getPool(), { schema })
}

export type Db = ReturnType<typeof createDb>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

let instance: Db | undefined

/**
 * The database, connected on first use: importing this module reads no environment, so
 * `next build` (and anything else that only imports it) needs no DATABASE_URL.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    instance ??= createDb()
    const value = Reflect.get(instance, prop, instance)
    return typeof value === 'function' ? value.bind(instance) : value
  },
})
