import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            // 共享包直接引用 TS 源码，由 Vite 转译，避免额外的构建步骤
            '@vulnagent/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
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
        host: '0.0.0.0',
        port: 5173,
        strictPort: false,
        allowedHosts: true,
        proxy: {
            '/api': {
                target: process.env.VITE_API_TARGET ?? 'http://localhost:3001',
                changeOrigin: true,
            },
            '/ws': {
                target: process.env.VITE_WS_TARGET ?? 'ws://localhost:3001',
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
