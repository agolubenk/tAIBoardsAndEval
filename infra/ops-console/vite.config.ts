import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('./web', import.meta.url))
const outDir = fileURLToPath(new URL('./dist', import.meta.url))

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir, emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 600 },
  server: {
    port: 5180,
    strictPort: true,
    // /queue — отдельная страница сервера (не маршрут SPA): на неё ведут ссылки колонки «Связь» на /deploys.
    proxy: { '/api': { target: 'http://127.0.0.1:8797', changeOrigin: false }, '/queue': { target: 'http://127.0.0.1:8797', changeOrigin: false } },
  },
})
