import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Pull TEST_DATABASE_URL from .env when it is not exported in the shell.
if (existsSync('.env')) process.loadEnvFile('.env')

const PORT = 3100

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  globalSetup: './tests/e2e/setup.ts',
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: 'npm run dev',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://pos:pos@localhost:5433/pos_test',
      // Test-only values so M-Pesa settings can be saved and callbacks reach this server.
      SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      APP_URL: `http://localhost:${PORT}`,
      CRON_SECRET: 'e2e-cron-secret',
    },
  },
})
