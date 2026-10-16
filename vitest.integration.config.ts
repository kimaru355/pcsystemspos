import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import path from 'node:path'

// Pull TEST_DATABASE_URL from .env when it is not exported in the shell.
const fileEnv = loadEnv('test', import.meta.dirname, '')
const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  fileEnv.TEST_DATABASE_URL ??
  'postgres://pos:pos@localhost:5433/pos_test'
// globalSetup runs in the main process, so it reads this directly.
process.env.TEST_DATABASE_URL = testDatabaseUrl

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['tests/helpers/global-setup.ts'],
    env: { DATABASE_URL: testDatabaseUrl },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
