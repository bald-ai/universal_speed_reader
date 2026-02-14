import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import devStorePlugin from './vite-plugin-dev-store';

export default defineConfig({
  plugins: [react(), devStorePlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3001,
  },
  build: {
    outDir: 'out',
  },
});
