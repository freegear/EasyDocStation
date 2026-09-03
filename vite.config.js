import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { loadViteAllowedHosts } from './scripts/vite-allowed-hosts.mjs'

const allowedHosts = loadViteAllowedHosts()

export default defineConfig({
  envDir: 'server',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts,
    watch: {
      ignored: [
        '**/.git/**',
        '**/.venv/**',
        '**/Database/**',
        '**/dist/**',
        '**/logs/**',
        '**/nohup.out',
        '**/server/**',
        '**/test-results/**',
        '**/tmp/**',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts,
  },
})
