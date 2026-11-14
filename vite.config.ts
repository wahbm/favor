import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: process.env.PUBLIC_BASE_PATH || '/',
  build: { outDir: 'dist/client' },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
