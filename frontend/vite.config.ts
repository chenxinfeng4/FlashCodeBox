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
    // 监听地址：与 Go 后端一致支持 HOST 环境变量；
    // 未设置时默认监听所有网卡（0.0.0.0），方便手机/局域网直接访问
    host: process.env.HOST || true,
    proxy: {
      // 开发模式：npm run dev 时把 API 代理到本地 Go 后端
      '/api': process.env.BACKEND || 'http://127.0.0.1:12345',
    },
  },
});
