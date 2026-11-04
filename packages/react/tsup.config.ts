import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.base.js'

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  external: ['react', 'react-dom', '@inksign/core', '@inksign/pdf', '@inksign/ui'],
})
