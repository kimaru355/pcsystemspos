import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    globalSetup: ['tests/helpers/global-setup.ts'],
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://pos:pos@localhost:5433/pos_test',
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
