import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// 前端源码位于 web/，构建产物输出到项目根 dist/，供 server.js 启动后直接服务。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3800',
      '/health': 'http://127.0.0.1:3800',
      '/login/state': 'http://127.0.0.1:3800',
      '/login/status': 'http://127.0.0.1:3800',
      '/logout': 'http://127.0.0.1:3800',
      '/session': 'http://127.0.0.1:3800',
      '/v1': 'http://127.0.0.1:3800',
      '/v2': 'http://127.0.0.1:3800',
    },
  },
});
