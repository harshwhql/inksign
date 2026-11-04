import { defineConfig } from 'tsup'
import { baseConfig } from '../../tsup.base.js'

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  external: ['vue', '@inksign/core', '@inksign/pdf', '@inksign/ui', 'pdfjs-dist', 'pdf-lib'],
})
