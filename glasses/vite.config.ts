import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5175, // distinct from web/ (5173) and the SSE server (5174)
    host: true, // allow QR access from phone/glasses over LAN
  },
  build: {
    target: 'es2020',
  },
})
