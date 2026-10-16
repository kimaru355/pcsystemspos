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

export const db = drizzle(getPool(), { schema })
export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
