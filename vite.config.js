import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  envDir: 'server',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['www.easystation.co.kr', 'easystation.co.kr', '218.237.25.214'],
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
})
