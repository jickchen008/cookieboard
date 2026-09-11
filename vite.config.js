import { defineConfig } from 'vite';

export default defineConfig({
  // 用相对路径，方便部署到任意子路径 / 静态托管
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    host: true,
  },
});
