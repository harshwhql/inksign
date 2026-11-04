import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.base.js'

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  external: ['@inksign/core', '@inksign/pdf', 'pdfjs-dist', 'pdf-lib'],
})
