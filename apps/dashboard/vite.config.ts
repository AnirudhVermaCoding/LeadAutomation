import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the API runs on :3000; same-origin in production (Fastify serves dist/).
const api = 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/v1': api, '/f': api, '/webhooks': api },
  },
});
