import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' —— 构建产物全部使用相对路径引用，保持反向代理子路径可用
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // 开发模式：npm run dev 时把 API 代理到本地 Go 后端
      '/api': 'http://127.0.0.1:12345',
    },
  },
});
