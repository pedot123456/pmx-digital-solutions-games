import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const API = `http://localhost:${process.env.PORT ?? 8090}`

export default defineConfig({
  root: here('./client'),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@shared': here('./shared') } },
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true },
    },
  },
  build: {
    outDir: here('./dist/client'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
