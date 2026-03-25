import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: { '/api': 'http://localhost:3000', '/auth': 'http://localhost:3000', '/ai': 'http://localhost:3000', '/kpi-segments': 'http://localhost:3000', '/qc-events': 'http://localhost:3000', '/qc-summary': 'http://localhost:3000', '/queue-snapshot': 'http://localhost:3000', '/queue-wait-summary': 'http://localhost:3000', '/users': 'http://localhost:3000', '/config': 'http://localhost:3000', '/health': 'http://localhost:3000' }
  },
  build: { outDir: '../dist', emptyOutDir: true }
});
