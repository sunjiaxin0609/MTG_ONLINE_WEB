import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 后端地址可用环境变量覆盖（默认 http://localhost:3000）。
const apiTarget = process.env.MTG_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 开发期把 /api 与 WebSocket 代理到后端，规避跨域。
    proxy: {
      '/api': apiTarget,
      '/ws': {
        target: apiTarget.replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
});