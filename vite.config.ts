import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadHaiaHandler } from './scripts/haia-loader.mjs';
import { createUiPreferencesHandler } from './scripts/server.mjs';

function localWorkbenchApi(): Plugin {
  async function configure(server: { middlewares: Connect.Server }) {
    const uiPrefsHandler = createUiPreferencesHandler();
    const haiaHandler = await loadHaiaHandler();
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';
      if (/^\/api\/ui-preferences(?:\?|$)/.test(url)) {
        uiPrefsHandler(req, res);
        return;
      }
      if (haiaHandler && /^\/api\/haia(?:\/|\?|$)/.test(url)) {
        void haiaHandler(req, res);
        return;
      }
      next();
    });
  }

  return { name: 'local-workbench-api', configureServer: configure, configurePreviewServer: configure };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), localWorkbenchApi()],
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
      ignored: ['**/gateway/**', '**/dist/**', '**/release/**', '**/.runtime', '**/.runtime/**'],
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
