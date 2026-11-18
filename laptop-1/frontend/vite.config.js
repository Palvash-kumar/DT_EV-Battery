import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The browser only ever talks to the Laptop 1 backend. In development Vite
// proxies /api and /socket.io to it, so the page and the API share one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.VITE_BACKEND_URL || 'http://localhost:3000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, ws: true, changeOrigin: true },
      },
    },
    preview: {
      port: 4173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, ws: true, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.js'],
    },
  };
});
