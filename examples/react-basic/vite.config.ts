import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // pdf.js ships its worker as a separate entry; let Vite pre-bundle it so
    // the dev server does not re-resolve it on every reload.
    include: ['pdfjs-dist', 'pdf-lib'],
  },
})
