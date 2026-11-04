import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 共享包直接引用 TS 源码，由 Vite 转译，避免额外的构建步骤
      '@vulnagent/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['echarts', 'echarts-for-react'],
          flow: ['@xyflow/react'],
          query: ['@tanstack/react-query', 'zustand'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    // 只监听回环地址：本机存在 VirtualBox / 多个虚拟网卡，
    // 绑 0.0.0.0 会让开发服务器暴露在所有网卡上，并干扰代理的出站源地址选择。
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
        configure: (proxy) => {
          // 代理失败默认静默返回 500，这里把真实错误打到终端便于排查。
          proxy.on('error', (err) => {
            console.error('[vite proxy error]', (err as NodeJS.ErrnoException)?.code ?? '', err?.message ?? err);
          });
        },
      },
      '/ws': {
        target: process.env.VITE_WS_TARGET ?? 'ws://127.0.0.1:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
