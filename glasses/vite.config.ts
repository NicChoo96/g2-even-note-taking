import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175, // distinct from the SSE server (5174)
    host: true, // allow QR access from phone/glasses over LAN
  },
  build: {
    target: 'es2020',
  },
})
