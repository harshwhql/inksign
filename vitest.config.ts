import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * `fileURLToPath` rather than `new URL(...).pathname`: on Windows the latter
 * yields a leading slash and percent-encoded spaces, which no resolver accepts.
 */
const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/index.ts',
        // Declaration-only: no runtime code to execute, so counting it as
        // zero percent would understate the real figure.
        'packages/core/src/types.ts',
      ],
      reporter: ['text', 'lcov'],
    },
  },
  resolve: {
    alias: {
      '@inksign/core': resolvePath('./packages/core/src/index.ts'),
      '@inksign/pdf': resolvePath('./packages/pdf/src/index.ts'),
      '@inksign/ui': resolvePath('./packages/ui/src/index.ts'),
      '@inksign/react': resolvePath('./packages/react/src/index.ts'),
    },
  },
})
