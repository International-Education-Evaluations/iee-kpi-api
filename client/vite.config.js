import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      // Auth
      '/auth': 'http://localhost:3000',
      // Data (backfill fast-reads)
      '/data': 'http://localhost:3000',
      // Backfill admin
      '/backfill': 'http://localhost:3000',
      // Legacy live endpoints (GAS, Bruno, Report Builder)
      '/kpi-segments': 'http://localhost:3000',
      '/kpi-classify': 'http://localhost:3000',
      '/credential-counts': 'http://localhost:3000',
      '/report-counts': 'http://localhost:3000',
      '/qc-events': 'http://localhost:3000',
      '/qc-orders': 'http://localhost:3000',
      '/qc-summary': 'http://localhost:3000',
      '/qc-discovery': 'http://localhost:3000',
      '/queue-snapshot': 'http://localhost:3000',
      '/queue-wait-summary': 'http://localhost:3000',
      '/users': 'http://localhost:3000',
      '/collections': 'http://localhost:3000',
      '/indexes': 'http://localhost:3000',
      // Config
      '/config': 'http://localhost:3000',
      // AI / Chat
      '/ai': 'http://localhost:3000',
      // Glossary
      '/glossary': 'http://localhost:3000',
      // Email
      '/email': 'http://localhost:3000',
      // Reports
      '/reports': 'http://localhost:3000',
      // User layout preferences
      '/user': 'http://localhost:3000',
      // Health check
      '/health': 'http://localhost:3000',
    }
  },
  build: { outDir: '../dist', emptyOutDir: true }
});
