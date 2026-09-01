import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

function developmentCspPlugin(): Plugin {
  return {
    name: 'dsr-development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "connect-src 'none'",
        "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"
      );
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
          chunkFileNames: '[name]-[hash].cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react(), developmentCspPlugin()]
  }
});
