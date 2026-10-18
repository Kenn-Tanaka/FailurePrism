import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pdfjs-dist')) return 'vendor-pdf';
            if (id.includes('xlsx')) return 'vendor-xlsx';
            if (id.includes('mammoth')) return 'vendor-mammoth';
            if (id.includes('@xyflow')) return 'vendor-xyflow';
            if (id.includes('lucide-react')) return 'vendor-icons';
            return 'vendor-core';
          }
          const toolMatch = id.replace(/\\/g, '/').match(/\/src\/tools\/([^/]+)\//);
          if (toolMatch) {
            return `tool-${toolMatch[1]}`;
          }
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        secure: false,
      },
      '/health': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        secure: false,
      },
    },
    watch: {
      ignored: ['**/gateway/**', '**/dist/**', '**/release/**'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        secure: false,
      },
      '/health': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
