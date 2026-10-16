import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../env'
import * as schema from './schema'

const pool = new Pool({ connectionString: getEnv().DATABASE_URL })

export const db = drizzle(pool, { schema })
export type Db = typeof db
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
